// Template cho site WordPress mới (ví dụ starter theme dùng Vite):
// nguồn là thư mục trên máy, tệp .zip hoặc địa chỉ Git. EzPanel tự nhận ra đó là giao diện (theme), plugin
// hay cả thư mục wp-content, chép vào site, chạy npm install / composer install nếu có và kích hoạt.

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const extractZip = (file, opts) => require('./util').unzip(file, opts.dir, opts); // tar.exe trên Windows
const { wrap, httpError } = require('./util');

const isWin = process.platform === 'win32';
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isGit = s => /^(https?:\/\/|git@|ssh:\/\/)\S+$/i.test(s) && !/\.zip$/i.test(s);
const slugify = s => String(s).toLowerCase().replace(/\.git$/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'theme';
const SKIP = new Set(['node_modules', '.git']);

// Đọc giá trị trong phần đầu của style.css hoặc tệp plugin ("Theme Name: …")
const header = (text, key) => (new RegExp(`^[\\s*#@/]*${key}:\\s*(.+)$`, 'mi').exec(text) || [])[1]?.trim() || null;

module.exports = (config, { laragon, wpTools, terminal, jobs }) => {
  const W = wpTools;
  config.templates = Array.isArray(config.templates) ? config.templates : [];
  const T = () => config.templates;
  const r = express.Router();
  const get = id => T().find(t => t.id === id) || null;

  // ---------- Lấy mã nguồn template về thư mục tạm ----------
  function gitExe() {
    if (laragon.detected()) {
      const g = path.join(laragon.P.root(), 'bin', 'git', 'cmd', isWin ? 'git.exe' : 'git');
      if (exists(g)) return g;
    }
    return 'git';
  }
  function run(cmd, args, opts, ctx) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { windowsHide: true, ...opts });
      let tail = '';
      const onData = d => {
        tail = (tail + d).slice(-4000);
        for (const line of String(d).split(/\r?\n/)) if (line.trim() && ctx) ctx.log(`  ${line.trim().slice(0, 200)}`);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolve(tail) : reject(new Error(tail.trim().split(/\r?\n/).slice(-2).join(' ') || `mã ${code}`))));
    });
  }
  async function copyDir(src, dest, skipTop) {
    await fsp.mkdir(dest, { recursive: true });
    for (const e of await fsp.readdir(src, { withFileTypes: true })) {
      if (SKIP.has(e.name) || skipTop?.(e.name)) continue;
      const a = path.join(src, e.name), b = path.join(dest, e.name);
      if (e.isDirectory()) await copyDir(a, b);
      else if (e.isFile()) await fsp.copyFile(a, b);
    }
  }
  // Trả về thư mục chứa mã nguồn template (đã bỏ lớp thư mục bọc ngoài của tệp zip)
  async function fetchSource(source, work, ctx) {
    const src = String(source || '').trim().replace(/^"|"$/g, '');
    const out = path.join(work, 'src');
    if (isGit(src)) {
      const [url, branch] = src.split('#');
      ctx?.step(`Tải template từ Git: ${url}`);
      try {
        await run(gitExe(), ['clone', '--depth', '1', ...(branch ? ['--branch', branch] : []), url, out], { env: process.env }, ctx);
      } catch (e) {
        throw httpError(400, `Không tải được từ Git (${e.message}). Kiểm tra địa chỉ, quyền truy cập repo, và máy đã có Git (Laragon có sẵn Git).`);
      }
      fs.rmSync(path.join(out, '.git'), { recursive: true, force: true });
      return { dir: out, base: slugify(path.basename(url)) };
    }
    if (/\.zip$/i.test(src) && exists(src)) {
      ctx?.step(`Giải nén template ${path.basename(src)}`);
      await extractZip(path.resolve(src), { dir: out });
      const items = fs.readdirSync(out).filter(n => !n.startsWith('__MACOSX'));
      const inner = items.length === 1 && isDir(path.join(out, items[0])) ? path.join(out, items[0]) : out;
      return { dir: inner, base: slugify(inner === out ? path.basename(src, '.zip') : items[0]) };
    }
    if (isDir(src)) {
      ctx?.step(`Chép template từ ${src}`);
      await copyDir(path.resolve(src), out);
      return { dir: out, base: slugify(path.basename(path.resolve(src))) };
    }
    throw httpError(400, 'Nguồn template phải là thư mục trên máy, tệp .zip hoặc địa chỉ Git (https://… hoặc git@…).');
  }

  // ---------- Nhận diện loại template ----------
  function detect(dir, base) {
    const manifest = readManifest(dir);
    if (manifest) return { ...manifest, type: manifest.type || 'site', dir, label: manifest.name || base, manifest: true };
    const preset = presetFor(dir);
    if (preset) return { ...preset, dir, label: `bộ khung site (${preset.theme})` };
    // Có wp-content và thư mục khác ở gốc (ví dụ _dev): chép chồng lên gốc site
    if (isDir(path.join(dir, 'wp-content'))) {
      const others = fs.readdirSync(dir).filter(n => !['wp-content', 'README.md', 'readme.md', '.gitignore', 'LICENSE', '.editorconfig'].includes(n) && !SKIP.has(n));
      if (others.length) return { type: 'site', dir, label: 'bộ khung site' };
    }
    const style = path.join(dir, 'style.css');
    if (exists(style)) {
      const name = header(fs.readFileSync(style, 'utf8').slice(0, 8000), 'Theme Name');
      if (name) return { type: 'theme', dir, slug: base, label: name };
    }
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.php'))) {
      const name = header(fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 8000), 'Plugin Name');
      if (name) return { type: 'plugin', dir, slug: base, label: name };
    }
    if (isDir(path.join(dir, 'wp-content'))) return { type: 'wp-content', dir: path.join(dir, 'wp-content'), label: 'wp-content' };
    if (isDir(path.join(dir, 'themes')) || isDir(path.join(dir, 'plugins'))) return { type: 'wp-content', dir, label: 'wp-content' };
    // Giao diện nằm trong thư mục con (repo có package.json ở gốc, theme ở theme/ hay src/…)
    const walk = (d, depth) => {
      if (depth > 3) return null;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (!e.isDirectory() || SKIP.has(e.name)) continue;
        const sub = path.join(d, e.name);
        const st = path.join(sub, 'style.css');
        if (exists(st)) {
          const name = header(fs.readFileSync(st, 'utf8').slice(0, 8000), 'Theme Name');
          if (name) return { type: 'theme', dir: sub, slug: slugify(e.name), label: name, nested: path.relative(dir, sub) };
        }
        const deeper = walk(sub, depth + 1);
        if (deeper) return deeper;
      }
      return null;
    };
    const nested = walk(dir, 0);
    if (nested) {
      // Repo kiểu "dự án" (package.json, vite.config ở gốc): chép cả repo làm giao diện để công cụ build chạy được
      const toolsAtRoot = ['package.json', 'composer.json', 'vite.config.js', 'vite.config.ts'].some(f => exists(path.join(dir, f)));
      return toolsAtRoot ? { ...nested, dir, slug: base, rootProject: true } : nested;
    }
    throw httpError(400, 'Không nhận ra template: cần style.css có "Theme Name", tệp plugin có "Plugin Name", hoặc thư mục wp-content.');
  }

  // ---------- Template kiểu "cả site": chép chồng lên gốc site, làm theo tpanel.json ----------
  // tpanel.json (tùy chọn) trong template:
  // { "type": "site", "rename": { "wp-content/themes/theme-name": "wp-content/themes/{{slug}}" },
  //   "replace": [{ "file": "...", "pattern": "regex", "flags": "m", "to": "…{{url}}…" }],
  //   "node": ">=20.19.0", "run": [{ "cwd": "_dev", "cmd": "npm install" }],
  //   "activateTheme": "{{slug}}", "plugins": ["classic-editor"], "options": { "uploads_use_yearmonth_folders": "0" } }
  // Biến: {{slug}} (tên dự án), {{url}} (địa chỉ site), {{title}} (tên website), {{domain}}
  function readManifest(dir) {
    const f = path.join(dir, 'tpanel.json');
    if (!exists(f)) return null;
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { throw httpError(400, `tpanel.json trong template không hợp lệ: ${e.message}`); }
  }
  // Mẫu dựng sẵn cho template kiểu wp-vite-starter (_dev/site.config.mjs + wp-content/themes/<giao diện>)
  function presetFor(dir) {
    const themesDir = path.join(dir, 'wp-content', 'themes');
    if (!exists(path.join(dir, '_dev', 'site.config.mjs')) || !isDir(themesDir)) return null;
    const themes = fs.readdirSync(themesDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    if (themes.length !== 1) return null;
    let node = null;
    try { node = JSON.parse(fs.readFileSync(path.join(dir, '_dev', 'package.json'), 'utf8')).engines?.node || null; } catch { /* không có */ }
    const hasScript = s => { try { return !!JSON.parse(fs.readFileSync(path.join(dir, '_dev', 'package.json'), 'utf8')).scripts?.[s]; } catch { return false; } };
    return {
      type: 'site', preset: 'wp-vite-starter', theme: themes[0],
      rename: { [`wp-content/themes/${themes[0]}`]: 'wp-content/themes/{{slug}}' },
      replace: [
        { file: '_dev/site.config.mjs', pattern: "(themeDir\\s*:\\s*['\"])[^'\"]*(['\"])", to: '$1../wp-content/themes/{{slug}}$2' },
        { file: '_dev/site.config.mjs', pattern: "(wpUrl\\s*:\\s*['\"])[^'\"]*(['\"])", to: '$1{{url}}$2' },
        { file: 'wp-content/themes/{{slug}}/style.css', pattern: '^([ \\t/*]*Theme Name:[ \\t]*).*$', flags: 'm', to: '$1{{title}}' },
      ],
      node,
      run: [{ cwd: '_dev', cmd: 'npm install --no-fund --no-audit' }, ...(hasScript('build') ? [{ cwd: '_dev', cmd: 'npm run build' }] : [])],
      activateTheme: '{{slug}}',
      plugins: ['classic-editor'],
      options: { uploads_use_yearmonth_folders: '0' },
    };
  }

  // Phiên bản Node mà dự án sẽ dùng (theo PATH của terminal EzPanel)
  function nodeVersion(env) {
    try {
      const out = require('child_process').execSync('node -v', { env, windowsHide: true, timeout: 10000 }).toString().trim();
      return (/v?(\d+\.\d+\.\d+)/.exec(out) || [])[1] || null;
    } catch { return null; }
  }
  const verGE = (a, b) => {
    const x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    return true;
  };
  // ">=20.19.0 || >=22.12" → đúng nếu thỏa một vế
  const nodeOk = (ver, range) => !range || String(range).split('||').some(part => {
    const m = /(\d+(?:\.\d+){0,2})/.exec(part);
    return !m || verGE(ver, m[1]);
  });

  async function applySite(name, d, src, ctx, vars) {
    const site = laragon.projectDir(name);
    const fill = s => String(s).replace(/\{\{(slug|url|title|domain)\}\}/g, (x, k) => vars[k]);
    const notes = [];
    ctx.step('Chép template vào gốc site');
    await copyDir(src, site, n => n === 'tpanel.json');
    for (const [from, to] of Object.entries(d.rename || {})) {
      const a = path.join(site, fill(from)), b = path.join(site, fill(to));
      if (a !== b && exists(a) && !exists(b)) { await fsp.rename(a, b); ctx.log(`  đổi tên ${fill(from)} → ${fill(to)}`); }
    }
    for (const rep of d.replace || []) {
      const f = path.join(site, fill(rep.file));
      if (!exists(f)) { ctx.log(`  bỏ qua ${fill(rep.file)} (không có)`); continue; }
      const text = fs.readFileSync(f, 'utf8');
      const next = text.replace(new RegExp(rep.pattern, rep.flags || ''), fill(rep.to));
      if (next !== text) { fs.writeFileSync(f, next); ctx.log(`  sửa ${fill(rep.file)}`); }
    }
    const env = terminal.context(name).env;
    let canRun = true;
    if (d.run?.length) {
      const ver = nodeVersion(env);
      if (!ver) { canRun = false; notes.push('Không tìm thấy Node.js. Cài Node.js (bản LTS) rồi mở Terminal của dự án để chạy các lệnh cài đặt.'); }
      else if (!nodeOk(ver, d.node)) {
        canRun = false;
        notes.push(`Template cần Node ${d.node} nhưng máy đang dùng Node ${ver}. Cài Node.js bản mới (LTS) rồi chạy "${d.run.map(x => x.cmd).join(' && ')}" trong ${d.run[0].cwd || '.'}.`);
      } else ctx.log(`  Node.js ${ver}`);
    }
    if (canRun) {
      const shell = cmd => (isWin ? ['cmd.exe', ['/d', '/s', '/c', cmd]] : ['sh', ['-c', cmd]]);
      for (const step of d.run || []) {
        const cwd = path.join(site, fill(step.cwd || '.'));
        ctx.step(`Chạy ${step.cmd}${step.cwd ? ` trong ${step.cwd}` : ''}`);
        const [c, a] = shell(fill(step.cmd));
        try { await run(c, a, { cwd, env }, ctx); } catch (e) {
          notes.push(`"${step.cmd}" chưa chạy được (${e.message.slice(0, 200)}). Mở Terminal của dự án, vào ${step.cwd || '.'} và chạy lại.`);
          break;
        }
      }
    }
    if (d.activateTheme) {
      const slug = fill(d.activateTheme);
      ctx.step(`Kích hoạt giao diện ${slug}`);
      await W.wp(name, ['theme', 'activate', slug]).catch(e => notes.push(`Chưa kích hoạt được giao diện ${slug}: ${e.message}`));
    }
    for (const p of d.plugins || []) {
      ctx.step(`Cài plugin ${p}`);
      await W.wp(name, ['plugin', 'install', p, '--activate']).catch(e => notes.push(`Chưa cài được plugin ${p} (${e.message.slice(0, 120)}). Cài trong trang quản trị WordPress.`));
    }
    for (const [k, v] of Object.entries(d.options || {})) {
      await W.wp(name, ['option', 'update', k, fill(v)], { safe: true }).catch(e => notes.push(`Chưa đặt được ${k}: ${e.message}`));
    }
    if (d.preset === 'wp-vite-starter') {
      notes.push(`Đã thiết lập theo README của template: giao diện ${vars.slug}, wpUrl ${vars.url}, Classic Editor, ảnh không chia theo tháng/năm.`);
      notes.push('Code: mở Terminal của dự án, gõ "cd _dev" rồi "npm run dev" (HTML tĩnh, http://localhost:3000) hoặc "npm run dev:wp" (giao diện PHP).');
    }
    try { laragon.writeDevInfo(name, true); } catch { /* bỏ qua */ }
    return { type: 'site', path: site.split(path.sep).join('/'), notes };
  }

  // ---------- Cài thư viện (npm, composer) ----------
  async function installDeps(name, dir, ctx) {
    const notes = [];
    const env = terminal.context(name).env;
    const shell = cmd => (isWin ? ['cmd.exe', ['/d', '/s', '/c', cmd]] : ['sh', ['-c', cmd]]);
    for (const [file, cmd, label] of [['composer.json', 'composer install --no-interaction', 'composer install'], ['package.json', 'npm install --no-fund --no-audit', 'npm install']]) {
      if (!exists(path.join(dir, file))) continue;
      ctx.step(`Chạy ${label} trong ${path.basename(dir)}`);
      const [c, a] = shell(cmd);
      try { await run(c, a, { cwd: dir, env }, ctx); } catch (e) {
        notes.push(`${label} chưa chạy được (${e.message.slice(0, 160)}). Mở Terminal của dự án và chạy lại "${label}".`);
      }
    }
    return notes;
  }

  // ---------- Áp dụng template vào site ----------
  async function apply(name, t, ctx, opts = {}) {
    const work = path.join(laragon.P.www(), `.lp-tpl-${crypto.randomBytes(4).toString('hex')}`);
    const site = laragon.projectDir(name);
    try {
      const src = await fetchSource(t.source, work, ctx);
      const d = detect(src.dir, src.base);
      if (d.type === 'site') {
        ctx.log(`  nhận diện: ${d.label}${d.manifest ? ' (theo tpanel.json)' : ''}`);
        let title = opts.title;
        if (!title) title = await W.wp(name, ['option', 'get', 'blogname'], { safe: true }).catch(() => name);
        const vars = { slug: slugify(t.slug || name), url: laragon.urlOf(name), title: String(title).trim() || name, domain: laragon.domainOf(name) };
        return await applySite(name, d, d.dir, ctx, vars);
      }
      ctx.log(`  nhận diện: ${d.type === 'theme' ? `giao diện "${d.label}"` : d.type === 'plugin' ? `plugin "${d.label}"` : 'thư mục wp-content'}${d.nested && !d.rootProject ? ` (trong ${d.nested})` : ''}`);
      const notes = [];
      let target;
      if (d.type === 'wp-content') {
        target = path.join(site, 'wp-content');
        ctx.step('Chép vào wp-content');
        await copyDir(d.dir, target);
      } else {
        const slug = slugify(t.slug || d.slug);
        target = path.join(site, 'wp-content', d.type === 'theme' ? 'themes' : 'plugins', slug);
        ctx.step(`Chép ${d.type === 'theme' ? 'giao diện' : 'plugin'} vào wp-content/${d.type === 'theme' ? 'themes' : 'plugins'}/${slug}`);
        fs.rmSync(target, { recursive: true, force: true });
        await copyDir(d.dir, target);
      }
      if (t.install !== false) notes.push(...await installDeps(name, target, ctx));
      if (d.type !== 'wp-content') {
        const slug = path.basename(target);
        ctx.step(`Kích hoạt ${d.type === 'theme' ? 'giao diện' : 'plugin'} ${slug}`);
        try {
          await W.wp(name, [d.type, 'activate', slug]);
        } catch (e) {
          notes.push(`Chưa kích hoạt được ${slug}: ${e.message}. Kích hoạt trong trang quản trị WordPress.`);
        }
      }
      notes.push(`Đã áp dụng template ${t.name}. Mã nguồn ở ${target.split(path.sep).join('/')}; mở Terminal của dự án để chạy "npm run dev".`);
      return { type: d.type, path: target, notes };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  // ---------- API ----------
  r.get('/', (req, res) => res.json({ templates: T() }));

  r.post('/', wrap(async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const source = String(b.source || '').trim().replace(/^"|"$/g, '');
    if (!name || name.length > 60) throw httpError(400, 'Hãy đặt tên template (tối đa 60 ký tự).');
    if (!isGit(source) && !exists(source)) throw httpError(400, 'Không tìm thấy nguồn: nhập đường dẫn thư mục, tệp .zip hoặc địa chỉ Git.');
    const item = { id: b.id && get(b.id) ? b.id : crypto.randomBytes(5).toString('hex'), name, source, install: b.install !== false, slug: b.slug ? slugify(b.slug) : null };
    config.templates = [...T().filter(t => t.id !== item.id), item];
    config.save();
    res.json({ ok: true, template: item });
  }));

  r.delete('/:id', wrap(async (req, res) => {
    config.templates = T().filter(t => t.id !== req.params.id);
    config.save();
    res.json({ ok: true });
  }));

  // Kiểm tra template: tải về tạm và nhận diện (không chép vào site nào)
  r.post('/inspect', wrap(async (req, res) => {
    const source = req.body?.source;
    const work = path.join(config.paths.tools, `.tpl-check-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(work, { recursive: true });
    try {
      const src = await fetchSource(source, work, null);
      const d = detect(src.dir, src.base);
      res.json({ ok: true, type: d.type, label: d.label, slug: d.slug || null, nested: d.rootProject ? null : d.nested || null,
        preset: d.preset || null, manifest: !!d.manifest, nodeRange: d.node || null,
        steps: d.type === 'site' ? [d.rename && 'đổi tên thư mục giao diện theo dự án', d.replace?.length && 'điền đường dẫn và địa chỉ site vào cấu hình',
          d.run?.length && d.run.map(x => x.cmd).join(', '), d.activateTheme && 'kích hoạt giao diện', d.plugins?.length && `cài plugin ${d.plugins.join(', ')}`,
          d.options && Object.keys(d.options).length && `đặt ${Object.keys(d.options).join(', ')}`].filter(Boolean) : null,
        npm: exists(path.join(d.dir, 'package.json')), composer: exists(path.join(d.dir, 'composer.json')),
        vite: ['vite.config.js', 'vite.config.ts', 'vite.config.mjs'].some(f => exists(path.join(d.dir, f)) || exists(path.join(d.dir, '_dev', f))) });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }));

  // Áp dụng template cho site WordPress có sẵn
  r.post('/:id/apply', wrap(async (req, res) => {
    const t = get(req.params.id);
    if (!t) throw httpError(404, 'Không tìm thấy template.');
    const name = req.body?.site;
    laragon.checkProject(name);
    if (!W.isWp(name)) throw httpError(400, 'Chỉ áp dụng template cho site WordPress.');
    res.json({ ok: true, job: jobs.start(`Áp dụng ${t.name} cho ${name}`, ctx => W.withLock(name, 'được áp dụng template', () => apply(name, t, ctx))) });
  }));

  return { router: r, get, apply };
};
