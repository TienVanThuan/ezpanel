// Bật / tắt Apache và MySQL của Laragon mà không cần mở giao diện Laragon.
// Chạy đúng httpd.exe và mysqld.exe theo phiên bản đang chọn trong Laragon.

const express = require('express');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFile } = require('child_process');
const mysql = require('mysql2/promise');
const { wrap, httpError } = require('./util');

const isWin = process.platform === 'win32';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };

// Cổng có đang mở không
function portOpen(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const sock = net.connect({ port, host });
    const done = ok => { sock.destroy(); resolve(ok); };
    sock.setTimeout(800, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}
async function waitPort(port, open, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(400)) {
    if (await portOpen(port) === open) return true;
  }
  return false;
}

// Danh sách tiến trình httpd / mysqld kèm đường dẫn tệp chạy
function listProcs() {
  return new Promise(resolve => {
    if (isWin) {
      const ps = "Get-CimInstance Win32_Process -Filter \"Name='httpd.exe' or Name='mysqld.exe' or Name='mariadbd.exe'\" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress";
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, out) => {
        if (err || !out.trim()) return resolve([]);
        try {
          const j = JSON.parse(out);
          resolve((Array.isArray(j) ? j : [j]).map(x => ({ pid: x.ProcessId, exe: x.ExecutablePath || '' })));
        } catch { resolve([]); }
      });
    } else {
      execFile('ps', ['-eo', 'pid=,args='], (err, out) => {
        if (err) return resolve([]);
        resolve(out.split('\n').map(l => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
          .map(m => ({ pid: Number(m[1]), exe: m[2] })));
      });
    }
  });
}
const norm = p => path.resolve(p).toLowerCase().replace(/\\/g, '/');

// Lệnh PowerShell chạy một chương trình ẩn hoàn toàn và độc lập với Sitebench.
// (Trên Windows, spawn "detached" của Node cấp cho chương trình một cửa sổ console riêng;
//  đóng cửa sổ đó là tắt luôn MySQL/Apache.)
function hiddenStartCommand(exe, args, cwd) {
  const ps = s => `'${String(s).replace(/'/g, "''")}'`;               // chuỗi PowerShell
  const arg = s => ps(`"${String(s).replace(/"/g, '\\"')}"`);         // giữ nguyên tham số có dấu cách
  return `Start-Process -FilePath ${ps(exe)} -WorkingDirectory ${ps(cwd)} -WindowStyle Hidden` +
    (args.length ? ` -ArgumentList ${args.map(arg).join(',')}` : '');
}

function launch(exe, args, cwd) {
  if (!isWin) {
    const child = spawn(exe, args, { cwd, detached: true, stdio: 'ignore' });
    child.unref();
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', hiddenStartCommand(exe, args, cwd)],
      { windowsHide: true, timeout: 30000 },
      (err, out, errOut) => (err ? reject(httpError(500, `Không chạy được ${path.basename(exe)}: ${(errOut || err.message).trim().split(/\r?\n/)[0]}`)) : resolve()));
  });
}

function killPid(pid) {
  return new Promise(resolve => {
    if (isWin) execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }, () => resolve());
    else { try { process.kill(pid, 'SIGTERM'); } catch { /* đã tắt */ } resolve(); }
  });
}

module.exports = (config, laragon) => {
  const L = config.laragon;
  const r = express.Router();
  let procCache = { at: 0, list: [] };

  async function procsUnder(dir) {
    if (Date.now() - procCache.at > 3000) procCache = { at: Date.now(), list: await listProcs() };
    const base = norm(dir);
    return procCache.list.filter(p => norm(p.exe.split(/\s+-/)[0].replace(/^"|"$/g, '')).startsWith(base) || (!isWin && p.exe.includes(dir)));
  }
  const fresh = () => { procCache.at = 0; };

  // ---------- Trạng thái ----------
  async function status() {
    const a = laragon.apache();
    const m = laragon.mysqlInfo();
    const [aProcs, mProcs] = await Promise.all([a ? procsUnder(a.dir) : [], m ? procsUnder(m.dir) : []]);
    const httpPort = Number(L.httpPort) || 80;
    const dbPort = Number(config.mysql.port) || 3306;
    const [aPort, mPort] = await Promise.all([portOpen(httpPort), portOpen(dbPort)]);
    const one = (info, procs, port, open) => ({
      version: info?.name || null,
      found: !!info,
      running: procs.length > 0 && open,
      starting: procs.length > 0 && !open,
      pids: procs.map(p => p.pid),
      port,
      // Cổng đang mở nhưng không phải tiến trình của Laragon
      portTaken: open && procs.length === 0,
    });
    return {
      apache: one(a, aProcs, httpPort, aPort),
      mysql: one(m, mProcs, dbPort, mPort),
      autoStart: !!L.autoStart,
    };
  }

  // ---------- Apache ----------
  async function startApache() {
    const a = laragon.apache();
    if (!a) throw httpError(404, 'Không tìm thấy Apache trong Laragon.');
    const st = await status();
    if (st.apache.running) return 'Apache đang chạy rồi.';
    if (st.apache.portTaken) {
      throw httpError(409, `Cổng ${st.apache.port} đang bị chương trình khác dùng (thường là IIS, Skype, XAMPP hoặc một Apache khác). Tắt chương trình đó rồi thử lại.`);
    }
    const t = await laragon.testApache();
    if (!t.ok) throw httpError(400, `Cấu hình Apache có lỗi nên chưa bật được: ${t.out.split(/\r?\n/).slice(-3).join(' ')}`);
    await launch(a.httpd, ['-d', a.dir, '-f', 'conf/httpd.conf'], a.dir);
    fresh();
    if (!(await waitPort(st.apache.port, true, 15000))) {
      throw httpError(500, `Apache không mở được cổng ${st.apache.port}. Xem nhật ký lỗi trong ${path.join(a.dir, 'logs', 'error.log')}.`);
    }
    return `Đã bật Apache (${a.name}).`;
  }
  async function stopApache() {
    const a = laragon.apache();
    if (!a) throw httpError(404, 'Không tìm thấy Apache trong Laragon.');
    fresh();
    const procs = await procsUnder(path.join(L.root, 'bin', 'apache'));
    if (!procs.length) return 'Apache chưa chạy.';
    for (const p of procs) await killPid(p.pid);
    fresh();
    await waitPort(Number(L.httpPort) || 80, false, 10000);
    return 'Đã tắt Apache.';
  }

  // ---------- MySQL ----------
  function mysqlArgs(m) {
    const args = [];
    const ini = ['my.ini', 'my.cnf'].map(f => path.join(m.dir, f)).find(exists);
    let hasDatadir = false;
    if (ini) {
      args.push(`--defaults-file=${ini}`);
      hasDatadir = /^\s*datadir\s*=/mi.test(fs.readFileSync(ini, 'utf8'));
    }
    if (!hasDatadir) {
      // Laragon để dữ liệu trong <laragon>\data\mysql-8, data\mysql…
      const major = (/(\d+)\.\d+/.exec(m.name) || [])[1];
      const kind = /mariadb/i.test(m.name) ? 'mariadb' : 'mysql';
      const guess = [`${kind}-${major}`, kind, m.name, 'mysql-8', 'mysql'].map(d => path.join(L.root, 'data', d)).find(exists);
      if (guess) args.push(`--datadir=${guess}`);
    }
    return args;
  }
  async function startMysql() {
    const m = laragon.mysqlInfo();
    if (!m) throw httpError(404, 'Không tìm thấy MySQL trong Laragon.');
    const st = await status();
    if (st.mysql.running) return 'MySQL đang chạy rồi.';
    if (st.mysql.portTaken) throw httpError(409, `Cổng ${st.mysql.port} đang bị chương trình khác dùng (thường là một MySQL khác hoặc dịch vụ MySQL của Windows).`);
    await launch(m.mysqld, mysqlArgs(m), m.dir);
    fresh();
    if (!(await waitPort(st.mysql.port, true, 30000))) {
      throw httpError(500, `MySQL không mở được cổng ${st.mysql.port} sau 30 giây. Xem tệp .err trong thư mục data của Laragon.`);
    }
    return `Đã bật MySQL (${m.name}).`;
  }
  async function stopMysql() {
    const m = laragon.mysqlInfo();
    if (!m) throw httpError(404, 'Không tìm thấy MySQL trong Laragon.');
    fresh();
    const procs = await procsUnder(path.join(L.root, 'bin', 'mysql'));
    if (!procs.length) return 'MySQL chưa chạy.';
    const port = Number(config.mysql.port) || 3306;
    // Tắt êm bằng lệnh SHUTDOWN để dữ liệu được ghi đầy đủ; không được thì mới buộc tắt
    let asked = false;
    try {
      const c = await mysql.createConnection({ ...config.mysql, connectTimeout: 3000 });
      await c.query('SHUTDOWN').then(() => { asked = true; }).catch(() => {});
      c.destroy();
    } catch { /* không kết nối được (ví dụ sai quyền): buộc tắt ngay */ }
    if (!asked || !(await waitPort(port, false, 20000))) {
      for (const p of procs) await killPid(p.pid);
      await waitPort(port, false, 5000);
    }
    await sleep(500);
    for (const p of await (fresh(), procsUnder(path.join(L.root, 'bin', 'mysql')))) await killPid(p.pid);
    fresh();
    return 'Đã tắt MySQL.';
  }

  const ACTIONS = {
    apache: { start: startApache, stop: stopApache, restart: async () => { await stopApache(); return (await startApache()).replace('bật', 'khởi động lại'); } },
    mysql: { start: startMysql, stop: stopMysql, restart: async () => { await stopMysql(); return (await startMysql()).replace('bật', 'khởi động lại'); } },
  };
  let busy = false;
  async function run(svc, action) {
    if (!laragon.detected()) throw httpError(400, 'Chưa tìm thấy Laragon.');
    if (busy) throw httpError(409, 'Đang bật/tắt dịch vụ khác, thử lại sau giây lát.');
    busy = true;
    try {
      if (svc === 'all') {
        const msgs = [];
        const order = action === 'stop' ? ['apache', 'mysql'] : ['mysql', 'apache'];
        const errors = [];
        for (const s of order) {
          try { msgs.push(await ACTIONS[s][action]()); } catch (e) { errors.push(e.message); }
        }
        if (errors.length) throw httpError(500, errors.join(' '));
        return msgs.join(' ');
      }
      if (!ACTIONS[svc]?.[action]) throw httpError(400, 'Thao tác không hợp lệ.');
      return await ACTIONS[svc][action]();
    } finally {
      busy = false;
      fresh();
    }
  }

  // Khởi động lại Apache nếu đang chạy (sau khi đổi cấu hình)
  async function reloadApacheIfRunning() {
    // Đang bật/tắt dịch vụ khác: chờ xong rồi khởi động lại (không bỏ qua, nếu không Apache vẫn chạy cấu hình cũ)
    for (let i = 0; busy && i < 120; i++) await new Promise(r => setTimeout(r, 500));
    const st = await status();
    if (!st.apache.running) return false;
    await run('apache', 'restart');
    return true;
  }

  // ---------- API ----------
  r.get('/', wrap(async (req, res) => res.json(await status())));
  r.post('/autostart', wrap(async (req, res) => {
    L.autoStart = !!req.body?.on;
    config.save();
    res.json({ ok: true });
  }));
  r.post('/:svc/:action', wrap(async (req, res) => {
    const message = await run(req.params.svc, req.params.action);
    res.json({ ok: true, message, status: await status() });
  }));

  return {
    router: r,
    status,
    run,
    reloadApacheIfRunning,
    async autoStart() {
      if (!L.autoStart || !laragon.detected()) return;
      try { console.log('  ' + await run('all', 'start')); } catch (e) { console.warn('  Tự bật Apache/MySQL: ' + e.message); }
    },
  };
};

module.exports.hiddenStartCommand = hiddenStartCommand;
