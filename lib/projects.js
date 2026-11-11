// Vòng đời dự án trong Laragon: thông tin, sao lưu, xóa (kèm mọi thứ liên quan), danh sách bản sao lưu, khôi phục.
// Bản sao lưu là tệp zip gồm: files/ (mã nguồn), database.sql (nếu có), tpanel.json (thông tin để cài lại).

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const extractZip = (file, opts) => require('./util').unzip(file, opts.dir, opts); // tar.exe trên Windows
const yauzl = require('yauzl');
const { wrap, httpError } = require('./util');

const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const NAME = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const DBNAME = /^[A-Za-z0-9_$-]{1,64}$/;
const BACKUP_FILE = /^[A-Za-z0-9_.-]+-\d{8}-\d{6}(-[a-z-]+)?\.zip$/;
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

async function dirSize(dir, limitMs = 8000) {
  const end = Date.now() + limitMs;
  let size = 0, files = 0, partial = false;
  const walk = async d => {
    if (Date.now() > end) { partial = true; return; }
    let list = [];
    try { list = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else { try { size += (await fsp.stat(p)).size; files++; } catch { /* bỏ qua */ } }
    }
  };
  await walk(dir);
  return { size, files, partial };
}

// Đọc một tệp nhỏ trong zip mà không giải nén cả tệp
function readZipEntry(file, names) {
  return new Promise(resolve => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err) return resolve(null);
      let done = false;
      const finish = v => { if (!done) { done = true; zip.close(); resolve(v); } };
      zip.on('entry', entry => {
        if (!names.includes(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry, (e, stream) => {
          if (e) return finish(null);
          let b = '';
          stream.on('data', d => { b += d; });
          stream.on('end', () => { try { finish(JSON.parse(b)); } catch { finish(null); } });
        });
      });
      zip.on('end', () => finish(null));
      zip.on('error', () => finish(null));
      zip.readEntry();
    });
  });
}

module.exports = (config, { laragon, dbtools, wpTools, wpExtras, certs, jobs }) => {
  const D = dbtools, W = wpTools, X = wpExtras;
  const r = express.Router();
  const backupsRoot = config.paths.backups;
  const need = () => { if (!laragon.detected()) throw httpError(400, 'Chưa tìm thấy Laragon.'); };
  const safeDir = n => { if (!n || /[\\/]/.test(n) || n.startsWith('.')) throw httpError(400, 'Tên không hợp lệ.'); return n; };

  // ---------- Thông tin dự án ----------
  async function info(name, { withSize = true } = {}) {
    need();
    laragon.checkProject(name);
    const dir = laragon.projectDir(name);
    const meta = X.readMeta()[name] || {};
    const kind = D.kindOf(dir);
    const db = D.projectDb(dir, meta);
    let dbInfo = null;
    if (db) {
      try {
        const rows = await D.query(`SELECT COUNT(*) AS tables, COALESCE(SUM(data_length + index_length), 0) AS size
          FROM information_schema.TABLES WHERE table_schema = ?`, [db.name]);
        dbInfo = { ...db, exists: await D.dbExists(db.name), tables: Number(rows[0].tables), size: Number(rows[0].size) };
      } catch (e) { dbInfo = { ...db, exists: null, error: e.message }; }
    }
    const st = laragon.projectState(name) || {};
    const domain = laragon.domainOf(name);
    const confs = [laragon.ownConf(name), laragon.autoConf(name)].filter(exists).map(f => path.basename(f));
    let inHosts = false;
    try { inHosts = laragon.inHosts(fs.readFileSync(laragon.hostsPath(), 'utf8'), domain); } catch { /* bỏ qua */ }
    return {
      name, kind, dir, domain, url: `${laragon.urlOf(name)}/`,
      size: withSize ? await dirSize(dir) : null,
      db: dbInfo,
      php: st.php ? laragon.versionOf(st.php) : null, phpFolder: st.php || null,
      https: !!st.https, lan: st.lan || null,
      confs, inHosts, meta,
      backups: listFor(name).length,
    };
  }

  // ---------- Sao lưu ----------
  const backupDir = name => path.join(backupsRoot, safeDir(name));
  async function backup(name, ctx, { db, reason } = {}) {
    const i = await info(name, { withSize: false });
    const dbName = db === undefined ? (i.db?.exists ? i.db.name : null) : db;
    fs.mkdirSync(backupDir(name), { recursive: true });
    const file = path.join(backupDir(name), `${name}-${stamp()}${reason ? `-${reason}` : ''}.zip`);
    const sqlFile = path.join(backupDir(name), `.db-${crypto.randomBytes(4).toString('hex')}.sql`);
    try {
      if (dbName) {
        ctx?.step(`Xuất database ${dbName}`);
        await D.dumpToFile(dbName, sqlFile, ctx);
      }
      ctx?.step('Nén mã nguồn và database');
      const meta = {
        tpanel: 1, name, kind: i.kind, domain: i.domain, created: new Date().toISOString(), reason: reason || null,
        db: dbName, php: i.phpFolder, phpVersion: i.php, https: i.https, lan: !!i.lan,
        prodUrl: i.meta.prodUrl || null, sourcePath: i.dir.split(path.sep).join('/'),
      };
      let added = 0;
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(file);
        const zip = archiver('zip', { zlib: { level: 6 } });
        out.on('close', resolve);
        zip.on('error', reject);
        zip.on('progress', p => {
          if (ctx && p.entries.processed - added > 2000) { added = p.entries.processed; ctx.log(`  đã nén ${added} tệp`); }
        });
        zip.pipe(out);
        if (dbName) zip.file(sqlFile, { name: 'database.sql' });
        zip.append(JSON.stringify(meta, null, 2), { name: 'tpanel.json' });
        zip.glob('**/*', { cwd: i.dir, dot: true, ignore: ['**/node_modules/**'] }, { prefix: 'files' }); // node_modules tạo lại bằng npm install
        zip.finalize();
      });
      ctx?.log(`  bản sao lưu: ${path.basename(file)} (${D.mb(fs.statSync(file).size)})`);
      return { file: path.basename(file), id: `${name}/${path.basename(file)}` };
    } catch (e) {
      fs.rmSync(file, { force: true });
      throw e;
    } finally {
      fs.rmSync(sqlFile, { force: true });
    }
  }

  // ---------- Xóa dự án ----------
  // Thứ tự an toàn: sao lưu → xóa thư mục (dễ lỗi nhất, ví dụ tệp đang mở) → cấu hình, chứng chỉ, database
  async function remove(name, ctx, opts) {
    const i = await info(name, { withSize: false });
    const dropDb = opts.dropDb && i.db?.exists ? i.db.name : null;
    if (dropDb && D.SYSTEM_DBS.includes(dropDb.toLowerCase())) throw httpError(400, 'Không được xóa database hệ thống.');
    let saved = null;
    if (opts.backup) saved = await backup(name, ctx, { db: i.db?.exists ? i.db.name : null, reason: 'truoc-khi-xoa' });

    ctx.step(`Xóa thư mục ${i.dir}`);
    try { await fsp.rm(i.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch (e) {
      throw httpError(409, `Không xóa được thư mục (${e.code === 'EBUSY' || e.code === 'EPERM' ? 'có tệp đang được chương trình khác mở, ví dụ VS Code, terminal hoặc npm run dev' : e.message}). Dự án chưa bị thay đổi gì khác${saved ? `; bản sao lưu ${saved.file} vẫn còn` : ''}.`);
    }
    ctx.step('Gỡ cấu hình Apache, PHP riêng, HTTPS, Wi-Fi');
    laragon.forget(name);
    for (const f of [laragon.ownConf(name), laragon.autoConf(name)]) fs.rmSync(f, { force: true });
    certs.removeSite(i.domain);
    // Dòng tên miền trong hosts: chỉ gỡ được khi có quyền ghi (không hỏi quyền admin chỉ để dọn dẹp)
    try {
      const h = laragon.hostsPath();
      const text = fs.readFileSync(h, 'utf8');
      const next = text.split(/\r?\n/).filter(l => !(l.includes('#LocalPanel') && new RegExp(`\\s${i.domain.replace(/\./g, '\\.')}(\\s|$)`).test(l))).join('\r\n');
      if (next !== text.replace(/\r?\n/g, '\r\n')) fs.writeFileSync(h, next);
    } catch { /* không có quyền: để lại, vô hại */ }
    if (dropDb) {
      ctx.step(`Xóa database ${dropDb}`);
      await D.query(`DROP DATABASE \`${dropDb.replace(/`/g, '``')}\``);
    }
    X.deleteMeta(name);
    ctx.step('Khởi động lại Apache');
    const ap = await laragon.afterApacheChange();
    return { name, backup: saved, droppedDb: dropDb, ...ap };
  }

  // ---------- Danh sách bản sao lưu ----------
  const metaCache = new Map();
  function listFor(name) {
    const d = path.join(backupsRoot, name);
    if (!exists(d)) return [];
    return fs.readdirSync(d).filter(f => BACKUP_FILE.test(f));
  }
  async function listAll() {
    if (!exists(backupsRoot)) return [];
    const out = [];
    for (const project of fs.readdirSync(backupsRoot)) {
      if (project.startsWith('.')) continue;
      for (const f of listFor(project)) {
        const file = path.join(backupsRoot, project, f);
        const st = fs.statSync(file);
        const key = `${file}|${st.mtimeMs}`;
        if (!metaCache.has(key)) metaCache.set(key, await readZipEntry(file, ['tpanel.json', 'localpanel.json']));
        const m = metaCache.get(key) || {};
        out.push({
          id: `${project}/${f}`, project, file: f, size: st.size, created: st.mtimeMs,
          kind: m.kind || (m.version ? 'wordpress' : null), db: m.db || null,
          phpVersion: m.phpVersion || m.phpVersion || null, reason: m.reason || null,
          deleted: !laragon.detected() || !exists(laragon.projectDir(project)),
        });
      }
    }
    return out.sort((a, b) => b.created - a.created);
  }
  function backupPath(id) {
    const [project, file] = String(id || '').split('/');
    if (!project || !file || !BACKUP_FILE.test(file)) throw httpError(400, 'Bản sao lưu không hợp lệ.');
    const p = path.join(backupsRoot, safeDir(project), file);
    if (!exists(p)) throw httpError(404, 'Không tìm thấy bản sao lưu.');
    return { project, file, path: p };
  }

  // ---------- Khôi phục / cài lại ----------
  async function restore(ctx, o) {
    need();
    const b = backupPath(o.id);
    const name = String(o.name || b.project).trim().toLowerCase();
    if (!NAME.test(name)) throw httpError(400, 'Tên dự án chỉ gồm chữ thường không dấu, số và dấu gạch ngang.');
    const dest = laragon.projectDir(name);
    if (exists(dest)) throw httpError(409, `Đã có dự án ${name} trong www. Chọn tên khác hoặc xóa dự án đó trước.`);
    const work = path.join(laragon.P.www(), `.lp-restore-${crypto.randomBytes(4).toString('hex')}`);
    let moved = false, createdDb = null;
    try {
      ctx.step(`Giải nén ${b.file}`);
      await extractZip(b.path, { dir: work });
      if (!exists(path.join(work, 'files'))) throw httpError(400, 'Bản sao lưu không có thư mục files/.');
      const meta = (() => { for (const f of ['tpanel.json', 'localpanel.json']) { try { return JSON.parse(fs.readFileSync(path.join(work, f), 'utf8')); } catch { /* thử tệp kế */ } } return {}; })();
      const oldName = meta.name || meta.site || b.project;
      const sql = path.join(work, 'database.sql');
      const kind = D.kindOf(path.join(work, 'files'));
      // Database: giữ tên cũ nếu còn trống, không thì tạo tên mới theo dự án
      let dbName = null;
      if (exists(sql)) {
        const oldDb = meta.db || D.projectDb(path.join(work, 'files'), {})?.name;
        dbName = String(o.db || '').trim() || (name === oldName && oldDb ? oldDb : `${kind === 'wordpress' ? 'wp' : 'db'}_${name.replace(/-/g, '_')}`);
        if (!DBNAME.test(dbName)) throw httpError(400, 'Tên database không hợp lệ.');
        if (await D.dbExists(dbName)) throw httpError(409, `Database ${dbName} đã tồn tại. Nhập tên database khác.`);
      }
      ctx.step(`Đưa mã nguồn vào ${dest}`);
      await fsp.rename(path.join(work, 'files'), dest);
      moved = true;
      if (dbName) {
        ctx.step(`Tạo database ${dbName} và nạp dữ liệu`);
        await D.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        createdDb = dbName;
        await D.importFile(sql, dbName, ctx);
      }
      const notes = [];
      // PHP riêng và HTTPS như lúc sao lưu (nếu phiên bản PHP đó còn trong Laragon)
      const php = o.php !== undefined ? (o.php || null) : (meta.php && laragon.phpVersions().includes(meta.php) ? meta.php : null);
      if (meta.php && !php && o.php === undefined) notes.push(`Laragon không còn PHP ${meta.phpVersion || meta.php}; dự án dùng PHP mặc định.`);
      const https = o.https !== undefined ? !!o.https : !!meta.https;
      if (php || https) {
        ctx.step('Cấu hình PHP riêng / HTTPS');
        await laragon.applyProject(name, { php, https });
      }
      const url = laragon.urlOf(name);
      if (kind === 'wordpress' && W.readConfig(name)) {
        ctx.step('Sửa wp-config.php');
        let cfg = W.readConfig(name);
        if (dbName) {
          cfg = W.setDefine(cfg, 'DB_NAME', W.phpStr(dbName));
          cfg = W.setDefine(cfg, 'DB_USER', W.phpStr(config.mysql.user));
          cfg = W.setDefine(cfg, 'DB_PASSWORD', W.phpStr(config.mysql.password || ''));
        }
        for (const k of ['WP_HOME', 'WP_SITEURL']) if (W.readDefine(cfg, k) !== null) cfg = W.setDefine(cfg, k, W.phpStr(url));
        fs.writeFileSync(W.configPath(name), cfg);
        if (dbName && name !== oldName) {
          ctx.step(`Đổi địa chỉ ${laragon.domainOf(oldName)} thành ${laragon.domainOf(name)}`);
          await W.wp(name, ['search-replace', `//${laragon.domainOf(oldName)}`, `//${laragon.domainOf(name)}`, '--all-tables-with-prefix', '--precise', '--report-changed-only'], { safe: true });
        }
        if (dbName) {
          const [from, to] = https ? [`http://${laragon.domainOf(name)}`, url] : [`https://${laragon.domainOf(name)}`, url];
          await W.wp(name, ['search-replace', from, to, '--all-tables-with-prefix', '--precise', '--report-changed-only'], { safe: true }).catch(() => {});
        }
      } else if (kind === 'laravel' && exists(path.join(dest, '.env'))) {
        let env = fs.readFileSync(path.join(dest, '.env'), 'utf8');
        const set = (k, v) => { env = new RegExp(`^${k}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`; };
        set('APP_URL', url);
        if (dbName) set('DB_DATABASE', dbName);
        fs.writeFileSync(path.join(dest, '.env'), env);
      } else if (dbName && dbName !== meta.db) {
        notes.push(`Database đổi tên thành ${dbName}; hãy sửa thông tin kết nối trong mã nguồn.`);
      }
      try { laragon.writeDevInfo(name); } catch { /* bỏ qua */ }
      X.setMeta(name, { kind, db: dbName, restoredFrom: b.id, ...(meta.prodUrl ? { prodUrl: meta.prodUrl } : {}) });
      ctx.step('Tạo tên miền và khởi động lại Apache');
      try { await laragon.ensureDomain(name); } catch (e) { notes.push(e.message); }
      const ap = await laragon.afterApacheChange();
      if (ap.reloadError) notes.push(ap.reloadError);
      if (meta.lan) notes.push('Lúc sao lưu dự án có bật xem qua Wi-Fi; bật lại trong mục Máy chủ & dự án nếu cần.');
      // node_modules không nằm trong bản sao lưu: nhắc chạy npm install ở những nơi có package.json
      const pkgDirs = [];
      const walk = (d, depth) => {
        if (depth > 4) return;
        let list = [];
        try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        if (list.some(e => e.name === 'package.json') && !list.some(e => e.name === 'node_modules')) pkgDirs.push(path.relative(dest, d).split(path.sep).join('/') || '.');
        for (const e of list) if (e.isDirectory() && !['node_modules', '.git', 'wp-admin', 'wp-includes', 'uploads'].includes(e.name)) walk(path.join(d, e.name), depth + 1);
      };
      walk(dest, 0);
      if (pkgDirs.length) notes.push(`Thư mục node_modules không nằm trong bản sao lưu: mở Terminal của dự án và chạy "npm install" trong ${pkgDirs.join(', ')}.`);
      return { name, kind, url: `${url}/`, db: dbName, notes };
    } catch (e) {
      ctx.log('Đang hoàn tác…');
      if (createdDb) await D.query(`DROP DATABASE IF EXISTS \`${createdDb}\``).catch(() => {});
      if (moved) { laragon.forget(name); fs.rmSync(dest, { recursive: true, force: true }); }
      throw e;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  // ---------- API ----------
  r.get('/backups', wrap(async (req, res) => res.json({ backups: await listAll(), dir: backupsRoot })));
  r.get('/backups/download', wrap(async (req, res) => { const b = backupPath(req.query.id); res.download(b.path, b.file); }));
  r.delete('/backups', wrap(async (req, res) => { fs.rmSync(backupPath(req.query.id).path, { force: true }); res.json({ ok: true }); }));
  r.post('/backups/restore', wrap(async (req, res) => {
    const o = req.body || {};
    backupPath(o.id);
    const id = jobs.start(`Khôi phục ${o.name || o.id.split('/')[0]}`, ctx => restore(ctx, o));
    res.json({ ok: true, job: id });
  }));

  r.get('/:name', wrap(async (req, res) => res.json(await info(req.params.name))));
  r.post('/:name/backup', wrap(async (req, res) => {
    const name = req.params.name;
    await info(name, { withSize: false });
    res.json({ ok: true, job: jobs.start(`Sao lưu ${name}`, ctx => W.withLock(name, 'được sao lưu', () => backup(name, ctx))) });
  }));
  r.post('/:name/delete', wrap(async (req, res) => {
    const name = req.params.name;
    if (req.body?.confirm !== name) throw httpError(400, 'Hãy gõ đúng tên dự án để xác nhận.');
    await info(name, { withSize: false });
    const opts = { backup: req.body?.backup !== false, dropDb: req.body?.dropDb !== false };
    res.json({ ok: true, job: jobs.start(`Xóa ${name}`, ctx => W.withLock(name, 'bị xóa', () => remove(name, ctx, opts))) });
  }));

  return { router: r, backup, listAll };
};
