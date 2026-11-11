// Terminal cho EzPanel:
//  1. Terminal trên web: phiên dòng lệnh thật (node-pty) truyền qua WebSocket tới xterm.js trong trình duyệt.
//  2. Mở cửa sổ terminal của Windows (Windows Terminal hoặc cmd) tại thư mục dự án.
// Cả hai đều đặt sẵn PATH: đúng PHP của dự án, MySQL, Composer, Git, Node, Python của Laragon và lệnh "wp".

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const { wrap, httpError } = require('./util');

let pty = null;
let ptyError = null;
try { pty = require('node-pty'); } catch (e) { ptyError = e.message; }

const isWin = process.platform === 'win32';
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const MAX_SESSIONS = 12;

module.exports = (config, { laragon, isLoggedIn, ensureWpCli, certs }) => {
  config.terminal = Object.assign({ enabled: true, shell: isWin ? 'cmd' : 'bash', allowRemote: false }, config.terminal || {});
  const T = config.terminal;
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
  const shimDir = path.join(config.paths.tools, 'bin');
  const sessions = new Set();

  function blockedReason() {
    if (!T.enabled) return 'Terminal trên web đang tắt.';
    if (!loopback && !T.allowRemote) return 'Terminal trên web tự tắt khi EzPanel mở ra mạng LAN (host khác 127.0.0.1). Muốn bật, đặt "terminal": { "allowRemote": true } trong config.json.';
    if (!pty) return `Thiếu thư viện node-pty (${ptyError}). Chạy lại setup.cmd để cài.`;
    return null;
  }

  // ---------- Môi trường dòng lệnh ----------
  const newest = dir => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
    } catch { return null; }
  };
  let sysNode;
  function systemNode() {
    if (sysNode !== undefined) return sysNode;
    try {
      const out = require('child_process').execSync('node -v', { windowsHide: true, timeout: 8000 }).toString();
      sysNode = (/(\d+\.\d+\.\d+)/.exec(out) || [])[1] || null;
    } catch { sysNode = null; }
    return sysNode;
  }
  const newerThan = (a, b) => {
    const x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
  };
  function laragonTools() {
    if (!laragon.detected()) return [];
    const bin = path.join(laragon.P.root(), 'bin');
    const out = [path.join(bin, 'composer'), path.join(bin, 'git', 'cmd')];
    // Máy không cài Node: dùng bản portable mà setup.cmd đã tải cho EzPanel
    const appNode = path.join(__dirname, '..', 'runtime', 'node');
    if (!systemNode() && exists(path.join(appNode, isWin ? 'node.exe' : 'node'))) out.push(appNode);
    // Node của Laragon chỉ được ưu tiên khi mới hơn Node đã cài trên máy (Vite mới cần Node ≥ 20.19)
    const node = newest(path.join(bin, 'nodejs'));
    if (node) {
      const lv = (/(\d+\.\d+\.\d+)/.exec(node) || [])[1];
      const sv = systemNode();
      if (!sv || (lv && newerThan(lv, sv))) out.push(path.join(bin, 'nodejs', node));
    }
    const py = newest(path.join(bin, 'python'));
    if (py) out.push(path.join(bin, 'python', py), path.join(bin, 'python', py, 'Scripts'));
    return out;
  }

  // Lệnh "wp" chạy WP-CLI bằng PHP đang có trong PATH (tức PHP của dự án)
  function ensureShims() {
    fs.mkdirSync(shimDir, { recursive: true });
    const cmd = path.join(shimDir, 'wp.cmd');
    const sh = path.join(shimDir, 'wp');
    if (!exists(cmd)) fs.writeFileSync(cmd, '@php "%~dp0..\\wp-cli.phar" %*\r\n');
    if (!exists(sh)) { fs.writeFileSync(sh, '#!/bin/sh\nexec php "$(dirname "$0")/../wp-cli.phar" "$@"\n'); fs.chmodSync(sh, 0o755); }
    if (ensureWpCli) ensureWpCli().catch(() => {}); // tải WP-CLI nếu chưa có, không chặn việc mở terminal
  }

  function context(project) {
    let name = null;
    if (project) {
      if (!laragon.detected()) throw httpError(400, 'Chưa tìm thấy Laragon.');
      name = laragon.checkProject(project);
    }
    const folder = laragon.detected() ? ((name && laragon.phpFor(name)) || laragon.defaultPhp()) : null;
    const dirs = [shimDir, folder && laragon.phpDir(folder), laragon.detected() && laragon.mysqlBin(), ...laragonTools()]
      .filter(d => d && exists(d));
    const env = { ...process.env };
    // Windows: biến môi trường không phân biệt hoa thường, giữ đúng tên khóa sẵn có (thường là "Path")
    const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
    env[key] = [...dirs, env[key] || ''].join(path.delimiter);
    if (folder) env.PHPRC = laragon.phpDir(folder);
    env.PHP_INI_SCAN_DIR = laragon.scanDir(process.env);
    // Node (BrowserSync, npm…) tin chứng chỉ HTTPS của EzPanel khi gọi https://ten.test
    try { if (certs?.hasCA()) env.NODE_EXTRA_CA_CERTS = certs.caPath; } catch { /* bỏ qua */ }
    env.LOCALPANEL_PROJECT = name || '';
    env.TERM = 'xterm-256color';
    const cwd = name ? laragon.projectDir(name) : laragon.detected() ? laragon.P.www() : config.paths.files;
    return { name, cwd, env, pathKey: key, dirs, phpVersion: folder ? laragon.versionOf(folder) : null };
  }

  // ---------- Các shell có trên máy ----------
  function shells() {
    if (!isWin) return [{ id: 'bash', label: 'Bash', file: process.env.SHELL || '/bin/bash', args: ['-i'] }];
    const list = [
      { id: 'cmd', label: 'Command Prompt (cmd)', file: 'cmd.exe', args: [] },
      { id: 'powershell', label: 'Windows PowerShell', file: 'powershell.exe', args: ['-NoLogo'] },
    ];
    if (laragon.detected()) {
      const bash = path.join(laragon.P.root(), 'bin', 'git', 'bin', 'bash.exe');
      if (exists(bash)) list.push({ id: 'gitbash', label: 'Git Bash (của Laragon)', file: bash, args: ['--login', '-i'] });
    }
    return list;
  }
  const shellOf = id => shells().find(s => s.id === id) || shells()[0];

  // ---------- Terminal trên web ----------
  const wss = new WebSocketServer({ noServer: true });

  function upgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/terminal/ws') return; // không phải của terminal
    const reject = (code, msg) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    // Chỉ nhận kết nối từ chính trang EzPanel, đã đăng nhập
    const origin = req.headers.origin;
    if (origin) {
      try { if (new URL(origin).host !== req.headers.host) return reject(403, 'Forbidden'); } catch { return reject(403, 'Forbidden'); }
    }
    if (!isLoggedIn(req)) return reject(401, 'Unauthorized');
    if (blockedReason()) return reject(403, 'Forbidden');
    if (sessions.size >= MAX_SESSIONS) return reject(429, 'Too Many Sessions');
    wss.handleUpgrade(req, socket, head, ws => startSession(ws, url.searchParams));
  }

  function startSession(ws, params) {
    const send = obj => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
    let ctx;
    ensureShims(); // tạo lệnh "wp" trước khi dựng PATH
    try { ctx = context(params.get('project') || null); } catch (e) {
      send({ t: 'o', d: `\r\n\x1b[31m${e.message}\x1b[0m\r\n` });
      send({ t: 'x', code: 1 });
      return ws.close();
    }
    const shell = shellOf(params.get('shell') || T.shell);
    const cols = Math.min(Math.max(Number(params.get('cols')) || 100, 20), 400);
    const rows = Math.min(Math.max(Number(params.get('rows')) || 30, 5), 200);

    let term;
    try {
      term = pty.spawn(shell.file, shell.args, { name: 'xterm-256color', cols, rows, cwd: ctx.cwd, env: ctx.env, useConpty: true });
    } catch (e) {
      send({ t: 'o', d: `\r\n\x1b[31mKhông mở được ${shell.label}: ${e.message}\x1b[0m\r\n` });
      send({ t: 'x', code: 1 });
      return ws.close();
    }
    sessions.add(term);

    const where = ctx.name ? `dự án ${ctx.name}` : 'thư mục www';
    send({ t: 'o', d: `\x1b[90mEzPanel · ${where}${ctx.phpVersion ? ` · PHP ${ctx.phpVersion}` : ''} · ${shell.label}\x1b[0m\r\n` });

    term.onData(d => send({ t: 'o', d }));
    term.onExit(({ exitCode }) => {
      sessions.delete(term);
      send({ t: 'x', code: exitCode });
      ws.close();
    });
    ws.on('message', raw => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'i' && typeof m.d === 'string') term.write(m.d);
      else if (m.t === 'r') {
        const c = Math.min(Math.max(Number(m.c) || cols, 20), 400);
        const r = Math.min(Math.max(Number(m.r) || rows, 5), 200);
        try { term.resize(c, r); } catch { /* phiên đã đóng */ }
      }
    });
    // Đóng tab hoặc tải lại trang thì tắt phiên
    ws.on('close', () => {
      if (sessions.has(term)) {
        sessions.delete(term);
        try { term.kill(); } catch { /* đã tắt */ }
      }
    });
    // Giữ kết nối, phát hiện trình duyệt đã mất
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const ping = setInterval(() => {
      if (!alive) { clearInterval(ping); return ws.terminate(); }
      alive = false;
      try { ws.ping(); } catch { /* bỏ qua */ }
    }, 30000);
    ws.on('close', () => clearInterval(ping));
  }

  // ---------- Mở cửa sổ terminal của Windows ----------
  let wtPath;
  function findWt() {
    if (wtPath !== undefined) return Promise.resolve(wtPath);
    return new Promise(resolve => {
      execFile('where', ['wt.exe'], { windowsHide: true }, (err, out) => {
        wtPath = err ? null : out.split(/\r?\n/)[0].trim() || null;
        resolve(wtPath);
      });
    });
  }

  async function openNative(project, shellId) {
    if (!isWin) throw httpError(400, 'Mở cửa sổ terminal chỉ dùng được trên Windows.');
    ensureShims();
    const ctx = context(project || null);
    const dir = path.join(config.paths.tools, 'term');
    fs.mkdirSync(dir, { recursive: true });
    const slug = (ctx.name || 'www').replace(/[^A-Za-z0-9_-]/g, '_');
    const title = `EzPanel - ${ctx.name || 'www'}${ctx.phpVersion ? ` - PHP ${ctx.phpVersion}` : ''}`;
    const prepend = ctx.dirs.join(';');
    let args;
    if (shellId === 'powershell') {
      const ps1 = path.join(dir, `${slug}.ps1`);
      const q = s => s.replace(/'/g, "''");
      fs.writeFileSync(ps1, '\ufeff' + [
        `$Host.UI.RawUI.WindowTitle = '${q(title)}'`,
        `$env:Path = '${q(prepend)};' + $env:Path`,
        ctx.env.PHPRC ? `$env:PHPRC = '${q(ctx.env.PHPRC)}'` : '',
        ctx.env.NODE_EXTRA_CA_CERTS ? `$env:NODE_EXTRA_CA_CERTS = '${q(ctx.env.NODE_EXTRA_CA_CERTS)}'` : '',
        `Set-Location -LiteralPath '${q(ctx.cwd)}'`,
        `Write-Host '${q(title)}' -ForegroundColor DarkGray`,
      ].join('\r\n'));
      args = ['powershell.exe', '-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', ps1];
    } else {
      const bat = path.join(dir, `${slug}.cmd`);
      fs.writeFileSync(bat, [
        '@echo off',
        'chcp 65001 >nul',
        `title ${title}`,
        `set "PATH=${prepend};%PATH%"`,
        ctx.env.PHPRC ? `set "PHPRC=${ctx.env.PHPRC}"` : '',
        ctx.env.NODE_EXTRA_CA_CERTS ? `set "NODE_EXTRA_CA_CERTS=${ctx.env.NODE_EXTRA_CA_CERTS}"` : '',
        `cd /d "${ctx.cwd}"`,
        `echo ${title}`,
      ].join('\r\n') + '\r\n');
      args = ['cmd.exe', '/k', bat];
    }
    const wt = await findWt();
    const child = wt
      ? spawn(wt, ['-w', 'new', '--title', title, '-d', ctx.cwd, ...args], { detached: true, stdio: 'ignore' })
      : spawn('cmd.exe', ['/c', 'start', title, ...args], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return { app: wt ? 'Windows Terminal' : 'Command Prompt', title };
  }

  // ---------- API ----------
  const r = express.Router();

  r.get('/', (req, res) => {
    const reason = blockedReason();
    let projects = [];
    try {
      if (laragon.detected()) {
        projects = laragon.projects().map(p => ({ name: p.name, php: p.php ? laragon.versionOf(p.php) : null }));
      }
    } catch { /* bỏ qua */ }
    res.json({
      enabled: T.enabled,
      available: !reason,
      reason,
      native: isWin,
      shell: shellOf(T.shell).id,
      shells: shells().map(({ id, label }) => ({ id, label })),
      defaultPhp: laragon.detected() && laragon.defaultPhp() ? laragon.versionOf(laragon.defaultPhp()) : null,
      projects,
      sessions: sessions.size,
    });
  });

  r.post('/config', wrap(async (req, res) => {
    if (typeof req.body?.enabled === 'boolean') T.enabled = req.body.enabled;
    if (req.body?.shell && shells().some(s => s.id === req.body.shell)) T.shell = req.body.shell;
    config.save();
    if (!T.enabled) for (const s of [...sessions]) { try { s.kill(); } catch { /* đã tắt */ } }
    res.json({ ok: true });
  }));

  r.post('/open', wrap(async (req, res) => {
    res.json({ ok: true, ...(await openNative(req.body?.project || null, req.body?.shell || T.shell)) });
  }));

  return {
    router: r,
    upgrade,
    context, // môi trường dòng lệnh của dự án (PATH có PHP, Node, Composer của Laragon)
    stopAll() { for (const s of sessions) { try { s.kill(); } catch { /* đã tắt */ } } },
  };
};
