// Cập nhật phần mềm đi kèm của máy chủ độc lập: PHP, Apache, MySQL/MariaDB.
// Nguyên tắc: không tự cập nhật khi chưa hỏi, luôn có đường lùi, ưu tiên khớp phiên bản của host.
//   PHP / Apache: bản mới đặt cạnh bản cũ, quay lại = trỏ về bản cũ.
//   MySQL cùng dòng: sao chép thư mục dữ liệu trước, lỗi thì tự khôi phục.
//   MySQL khác dòng: xuất toàn bộ database rồi nạp vào bản mới (thư mục dữ liệu mới), dữ liệu cũ giữ nguyên.

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { wrap, httpError } = require('./util');

const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const verOf = s => (/(\d+\.\d+\.\d+)/.exec(s || '') || [])[1] || null;
const cmpVer = (a, b) => {
  const x = (a || '0').split('.').map(Number), y = (b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
// Kiểm tra một URL có tồn tại không (HEAD, theo chuyển hướng)
function headOk(url, depth = 0) {
  return new Promise(resolve => {
    const req = https.request(url, { method: 'HEAD', timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 EzPanel' } }, res => {
      res.resume();
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && depth < 5) return resolve(headOk(new URL(res.headers.location, url).href, depth + 1));
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

module.exports = (config, { laragon, runtime, services, dbtools, jobs }) => {
  const r = express.Router();
  const D = dbtools;
  const histFile = () => path.join(laragon.P.root(), 'usr', 'tpanel-updates.json');
  const readHist = () => { try { return JSON.parse(fs.readFileSync(histFile(), 'utf8')); } catch { return []; } };
  const addHist = e => {
    const list = [...readHist(), { id: crypto.randomBytes(4).toString('hex'), at: new Date().toISOString(), ...e }].slice(-50);
    fs.mkdirSync(path.dirname(histFile()), { recursive: true });
    fs.writeFileSync(histFile(), JSON.stringify(list, null, 2));
  };
  const needStandalone = () => { if (!laragon.standalone()) throw httpError(400, 'Cập nhật phần mềm đi kèm dùng cho chế độ máy chủ độc lập (Laragon tự cập nhật phần mềm của nó).'); };
  let last = { at: null, items: [] };

  // ---------- Kiểm tra bản mới ----------
  async function check() {
    if (!laragon.standalone() || !laragon.detected()) { last = { at: Date.now(), items: [] }; return last; }
    const items = [];
    const errors = [];
    // PHP: bản mới nhất cùng dòng (mỗi dòng xét bản cao nhất đang cài)
    try {
      const cat = await laragon.phpCatalog();
      const bySeries = {};
      for (const f of laragon.phpVersions()) {
        const v = laragon.versionOf(f), series = v.split('.').slice(0, 2).join('.');
        if (!bySeries[series] || cmpVer(v, laragon.versionOf(bySeries[series])) > 0) bySeries[series] = f;
      }
      for (const [series, folder] of Object.entries(bySeries)) {
        const latest = cat.find(x => x.version.startsWith(`${series}.`));
        if (latest && cmpVer(latest.version, laragon.versionOf(folder)) > 0) {
          items.push({ kind: 'php', label: `PHP ${series}`, from: folder, current: laragon.versionOf(folder), latest: latest.version, file: latest.file });
        }
      }
    } catch (e) { errors.push(`PHP: ${e.message}`); }
    // Apache
    try {
      const a = laragon.apache();
      const [latest] = await runtime.apacheCatalog();
      if (a && latest && cmpVer(latest.version, verOf(a.name)) > 0) items.push({ kind: 'apache', label: 'Apache', from: a.name, current: verOf(a.name), latest: latest.version });
    } catch (e) { errors.push(`Apache: ${e.message}`); }
    // MySQL / MariaDB cùng dòng
    try {
      const m = laragon.mysqlInfo();
      const cur = verOf(m?.name);
      if (m && cur) {
        const [maj, min, patch] = cur.split('.').map(Number);
        if (/mariadb/i.test(m.name)) {
          const rel = await runtime.mariadbRelease(`${maj}.${min}`);
          if (cmpVer(rel.version, cur) > 0) items.push({ kind: 'mysql', type: 'mariadb', label: `MariaDB ${maj}.${min}`, from: m.name, current: cur, latest: rel.version, version: `${maj}.${min}` });
        } else {
          // MySQL không có API danh sách: dò các bản vá kế tiếp trên máy chủ tải chính thức
          let found = null;
          for (let p = patch + 1; p <= patch + 8; p++) {
            const v = `${maj}.${min}.${p}`;
            if (await headOk(`https://cdn.mysql.com/Downloads/MySQL-${maj}.${min}/mysql-${v}-winx64.zip`)) found = v;
          }
          if (found) items.push({ kind: 'mysql', type: 'mysql', label: `MySQL ${maj}.${min}`, from: m.name, current: cur, latest: found, version: found });
        }
      }
    } catch (e) { errors.push(`Database: ${e.message}`); }
    last = { at: Date.now(), items, errors };
    return last;
  }

  // ---------- Cập nhật ----------
  async function updatePhp(ctx, item) {
    const cat = await laragon.phpCatalog();
    const target = cat.find(x => x.version === item.latest);
    if (!target) throw httpError(404, `Không còn PHP ${item.latest} trên trang tải.`);
    ctx.step(`Tải PHP ${item.latest}`);
    const res = await laragon.installPhp(target.file);
    const oldDir = path.join(laragon.P.php(), item.from), newDir = path.join(laragon.P.php(), res.folder);
    // Giữ cài đặt: php.ini và Xdebug của bản cũ
    ctx.step('Chép php.ini và Xdebug từ bản cũ');
    if (exists(path.join(oldDir, 'php.ini'))) fs.copyFileSync(path.join(oldDir, 'php.ini'), path.join(newDir, 'php.ini'));
    try {
      for (const f of fs.readdirSync(path.join(oldDir, 'ext')).filter(n => /^php_xdebug.*\.dll$/i.test(n))) {
        if (!exists(path.join(newDir, 'ext', f))) fs.copyFileSync(path.join(oldDir, 'ext', f), path.join(newDir, 'ext', f));
      }
    } catch { /* bản cũ không có Xdebug */ }
    ctx.step('Chuyển các dự án sang bản mới');
    const wasDefault = laragon.defaultPhp() === item.from;
    if (wasDefault) runtime.setActive('php', res.folder);
    const n = await laragon.repointPhp(item.from, res.folder);
    const ap = await laragon.afterApacheChange();
    addHist({ kind: 'php', from: item.from, to: res.folder, wasDefault });
    return { message: `Đã cập nhật PHP ${item.current} lên ${item.latest}${wasDefault ? ' (PHP mặc định)' : ''}, ${n} dự án dùng PHP riêng được chuyển sang.`, ...ap };
  }

  async function updateApache(ctx) {
    const prev = laragon.apache()?.name;
    const wasRunning = (await services.status()).apache.running;
    const folder = await runtime.installApache(ctx);
    ctx.step('Kiểm tra cấu hình với bản mới');
    await laragon.refreshConfs();
    const t = await laragon.testApache();
    if (!t.ok && !t.skipped) {
      runtime.setActive('apache', prev);
      runtime.regenerateApache();
      throw httpError(500, `Bản Apache mới báo lỗi cấu hình nên EzPanel đã quay lại ${prev}: ${t.error}`);
    }
    if (wasRunning) { ctx.step('Khởi động lại Apache'); await services.run('apache', 'restart'); }
    addHist({ kind: 'apache', from: prev, to: folder });
    return { message: `Đã cập nhật Apache lên ${folder}.` };
  }

  const datadirOf = m => {
    const ini = path.join(m.dir, 'my.ini');
    const d = exists(ini) ? (/^\s*datadir\s*=\s*"?([^"\r\n]+?)"?\s*$/mi.exec(fs.readFileSync(ini, 'utf8')) || [])[1] : null;
    return d ? path.resolve(d) : null;
  };
  async function waitMysql(ms = 60000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { await D.query('SELECT 1'); return true; } catch { await new Promise(res => setTimeout(res, 1500)); }
    }
    return false;
  }

  // Cùng dòng: sao chép thư mục dữ liệu, đổi chương trình, khởi động (MySQL tự nâng cấp dữ liệu); lỗi thì khôi phục
  async function updateMysql(ctx, item) {
    const m = laragon.mysqlInfo();
    const datadir = datadirOf(m);
    if (!datadir || !exists(datadir)) throw httpError(400, 'Không xác định được thư mục dữ liệu MySQL.');
    const backup = `${datadir}.truoc-${item.latest}-${stamp()}`;
    ctx.step('Tắt MySQL');
    await services.run('mysql', 'stop');
    ctx.step(`Sao chép thư mục dữ liệu (để quay lại khi cần)`);
    await fsp.cp(datadir, backup, { recursive: true });
    let folder;
    try {
      folder = await runtime.installDatabase(ctx, { type: item.type, version: item.version });
      ctx.step(`Khởi động ${folder}`);
      await services.run('mysql', 'start');
      if (!(await waitMysql())) throw new Error('MySQL không khởi động được với bản mới');
    } catch (e) {
      ctx.log(`Lỗi: ${e.message}. Đang khôi phục…`);
      await services.run('mysql', 'stop').catch(() => {});
      fs.rmSync(datadir, { recursive: true, force: true });
      await fsp.rename(backup, datadir);
      runtime.setActive('mysql', m.name);
      await services.run('mysql', 'start').catch(() => {});
      throw httpError(500, `Cập nhật thất bại nên EzPanel đã khôi phục ${m.name} và dữ liệu cũ: ${e.message}`);
    }
    addHist({ kind: 'mysql', from: m.name, to: folder, datadir, backup });
    return { message: `Đã cập nhật lên ${folder}. Bản sao dữ liệu cũ: ${path.basename(backup)} (xóa khi đã chạy ổn).` };
  }

  // Khác dòng (8.0 → 8.4, MySQL ↔ MariaDB): xuất toàn bộ database, cài bản mới với dữ liệu mới, nạp lại
  async function upgradeSeries(ctx, o) {
    const m = laragon.mysqlInfo();
    if (!m) throw httpError(400, 'Chưa có MySQL.');
    ctx.step('Bật MySQL hiện tại để xuất dữ liệu');
    await services.run('mysql', 'start').catch(() => {});
    if (!(await waitMysql())) throw httpError(500, 'Không bật được MySQL hiện tại.');
    const dbs = (await D.query('SHOW DATABASES')).map(x => x.Database).filter(d => !D.SYSTEM_DBS.includes(d.toLowerCase()));
    const dir = path.join(config.paths.tools, `nang-cap-${stamp()}`);
    fs.mkdirSync(dir, { recursive: true });
    try {
      for (const db of dbs) { ctx.step(`Xuất ${db}`); await D.dumpToFile(db, path.join(dir, `${encodeURIComponent(db)}.sql`), ctx); }
      ctx.step('Tắt MySQL hiện tại');
      await services.run('mysql', 'stop');
      let folder;
      try {
        folder = await runtime.installDatabase(ctx, { type: o.type, version: o.version });
        ctx.step(`Khởi động ${folder}`);
        await services.run('mysql', 'start');
        if (!(await waitMysql())) throw new Error('bản mới không khởi động được');
        for (const db of dbs) {
          ctx.step(`Nạp ${db}`);
          await D.query(`CREATE DATABASE IF NOT EXISTS \`${db.replace(/`/g, '``')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
          await D.importFile(path.join(dir, `${encodeURIComponent(db)}.sql`), db, ctx);
        }
      } catch (e) {
        ctx.log(`Lỗi: ${e.message}. Đang quay lại ${m.name}…`);
        await services.run('mysql', 'stop').catch(() => {});
        runtime.setActive('mysql', m.name);
        await services.run('mysql', 'start').catch(() => {});
        throw httpError(500, `Nâng cấp thất bại nên EzPanel đã quay lại ${m.name} (dữ liệu cũ nguyên vẹn): ${e.message}`);
      }
      addHist({ kind: 'mysql-series', from: m.name, to: folder, databases: dbs.length });
      return { message: `Đã nâng cấp lên ${folder} và chuyển ${dbs.length} database. Dữ liệu của ${m.name} vẫn giữ nguyên (quay lại được). Tài khoản MySQL khác root cần tạo lại nếu có.` };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---------- Quay lại bản trước ----------
  async function rollback(id) {
    const e = readHist().find(x => x.id === id);
    if (!e) throw httpError(404, 'Không tìm thấy lần cập nhật này.');
    if (e.kind === 'php') {
      if (!laragon.phpVersions().includes(e.from)) throw httpError(400, `Bản ${e.from} đã bị xóa.`);
      if (laragon.defaultPhp() === e.to) runtime.setActive('php', e.from);
      await laragon.repointPhp(e.to, e.from);
      await laragon.afterApacheChange();
    } else if (e.kind === 'apache') {
      const wasRunning = (await services.status()).apache.running;
      if (wasRunning) await services.run('apache', 'stop');
      runtime.setActive('apache', e.from);
      runtime.regenerateApache();
      await laragon.refreshConfs();
      if (wasRunning) await services.run('apache', 'start');
    } else if (e.kind === 'mysql') {
      if (!exists(e.backup)) throw httpError(400, 'Bản sao dữ liệu cũ không còn (có thể đã bị xóa).');
      await services.run('mysql', 'stop');
      await fsp.rename(e.datadir, `${e.datadir}.sau-${stamp()}`);
      await fsp.cp(e.backup, e.datadir, { recursive: true });
      runtime.setActive('mysql', e.from);
      await services.run('mysql', 'start');
    } else if (e.kind === 'mysql-series') {
      await services.run('mysql', 'stop');
      runtime.setActive('mysql', e.from);
      await services.run('mysql', 'start');
    }
    addHist({ kind: 'rollback', from: e.to, to: e.from, of: e.id });
    return { message: `Đã quay lại ${e.from}.${e.kind === 'mysql-series' ? ' Dữ liệu thay đổi sau khi nâng cấp không có ở bản cũ.' : ''}` };
  }

  // Kiểm tra định kỳ (lúc khởi động và mỗi ngày), chỉ đọc thông tin, không tự cài
  setTimeout(() => { check().catch(() => {}); setInterval(() => check().catch(() => {}), 24 * 3600 * 1000).unref(); }, 90 * 1000).unref();

  // ---------- API ----------
  r.get('/', (req, res) => res.json({ ...last, history: laragon.detected() ? readHist().slice(-15).reverse() : [], standalone: laragon.standalone() }));
  r.post('/check', wrap(async (req, res) => { needStandalone(); res.json(await check()); }));
  r.post('/apply', wrap(async (req, res) => {
    needStandalone();
    const item = last.items.find(x => x.kind === req.body?.kind && x.from === req.body?.from);
    if (!item) throw httpError(404, 'Không có bản cập nhật này. Bấm Kiểm tra lại.');
    const run = { php: updatePhp, apache: updateApache, mysql: updateMysql }[item.kind];
    res.json({ ok: true, job: jobs.start(`Cập nhật ${item.label} lên ${item.latest}`, async ctx => { const out = await run(ctx, item); last.items = last.items.filter(x => x !== item); return out; }) });
  }));
  r.post('/database-series', wrap(async (req, res) => {
    needStandalone();
    const o = { type: req.body?.type === 'mariadb' ? 'mariadb' : 'mysql', version: String(req.body?.version || '').trim() };
    if (o.type === 'mysql' && !/^\d+\.\d+\.\d+$/.test(o.version)) throw httpError(400, 'Nhập đúng phiên bản MySQL, ví dụ 8.4.6.');
    if (o.type === 'mariadb' && !/^\d+\.\d+$/.test(o.version)) throw httpError(400, 'Nhập dòng MariaDB, ví dụ 11.4.');
    res.json({ ok: true, job: jobs.start(`Nâng cấp database lên ${o.type === 'mysql' ? 'MySQL' : 'MariaDB'} ${o.version}`, ctx => upgradeSeries(ctx, o)) });
  }));
  r.post('/rollback', wrap(async (req, res) => { needStandalone(); res.json({ ok: true, ...(await rollback(req.body?.id)) }); }));

  return { router: r, check, pending: () => last.items.length };
};
