// Mục Database (MySQL/MariaDB): danh sách database kèm dung lượng, số bảng và dự án đang dùng;
// danh sách bảng; xem dữ liệu có phân trang, tìm kiếm, sắp xếp; xuất / nhập tệp .sql.

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { wrap, httpError } = require('./util');

const DBNAME = /^[^\x00/\\.]{1,64}$/;
const q = s => '`' + String(s).replace(/`/g, '``') + '`';
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

module.exports = (config, { laragon, dbtools, jobs, wpExtras }) => {
  const D = dbtools;
  const r = express.Router();
  const checkDb = name => {
    if (!DBNAME.test(name || '') || name !== name.trim()) throw httpError(400, 'Tên database không hợp lệ.');
    return name;
  };
  // Bảng phải có thật trong database (tên lấy từ MySQL, không tin dữ liệu gửi lên)
  async function checkTable(db, table) {
    const rows = await D.query('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [db, table]);
    if (!rows.length) throw httpError(404, 'Không tìm thấy bảng này.');
    return rows[0].t;
  }

  // Dự án nào đang dùng database nào
  function usage() {
    const map = {};
    if (!laragon.detected()) return map;
    const meta = wpExtras.readMeta();
    for (const p of laragon.projects()) {
      const db = D.projectDb(laragon.projectDir(p.name), meta[p.name]);
      if (db) (map[db.name] = map[db.name] || []).push(p.name);
    }
    return map;
  }

  r.get('/databases', wrap(async (req, res) => {
    let version;
    try { version = (await D.query('SELECT VERSION() AS v'))[0].v; } catch (e) {
      const { password, ...shown } = config.mysql;
      return res.json({ connected: false, error: e.message, config: shown });
    }
    const dbs = await D.query('SHOW DATABASES');
    const stats = await D.query(`SELECT TABLE_SCHEMA AS db, COUNT(*) AS tables, COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS size
      FROM information_schema.TABLES GROUP BY TABLE_SCHEMA`);
    const by = Object.fromEntries(stats.map(s => [s.db, s]));
    const used = usage();
    const { password, ...shown } = config.mysql;
    res.json({
      connected: true, version, config: shown,
      databases: dbs.map(d => d.Database).map(name => ({
        name,
        system: D.SYSTEM_DBS.includes(name.toLowerCase()),
        tables: Number(by[name]?.tables || 0),
        size: Number(by[name]?.size || 0),
        projects: used[name] || [],
      })),
    });
  }));

  r.get('/:db/tables', wrap(async (req, res) => {
    const db = checkDb(req.params.db);
    const rows = await D.query(`SELECT TABLE_NAME AS name, TABLE_ROWS AS rows_, DATA_LENGTH + INDEX_LENGTH AS size, ENGINE AS engine, TABLE_TYPE AS type
      FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [db]);
    res.json({ tables: rows.map(t => ({ name: t.name, rows: Number(t.rows_ || 0), size: Number(t.size || 0), engine: t.engine, view: t.type === 'VIEW' })) });
  }));

  // Dữ liệu một bảng: ?page=1&per=50&q=tu-khoa&sort=cot&dir=asc|desc
  r.get('/:db/table/:table', wrap(async (req, res) => {
    const db = checkDb(req.params.db);
    const table = await checkTable(db, req.params.table);
    const per = Math.min(500, Math.max(10, Number(req.query.per) || 50));
    const page = Math.max(1, Number(req.query.page) || 1);
    const cols = await D.query(`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, COLUMN_KEY AS k, IS_NULLABLE AS nullable
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [db, table]);
    const names = cols.map(c => c.name);
    const sort = names.includes(req.query.sort) ? req.query.sort : null;
    const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
    const term = String(req.query.q || '').trim();
    const where = term ? `WHERE CONCAT_WS(' ', ${names.map(n => `CAST(${q(n)} AS CHAR)`).join(', ')}) LIKE ?` : '';
    const params = term ? [`%${term.replace(/[\\%_]/g, m => `\\${m}`)}%`] : [];
    const [{ total }] = await D.query(`SELECT COUNT(*) AS total FROM ${q(table)} ${where}`, params, db);
    const rows = await D.query(`SELECT * FROM ${q(table)} ${where} ${sort ? `ORDER BY ${q(sort)} ${dir}` : ''} LIMIT ${per} OFFSET ${(page - 1) * per}`, params, db);
    const cell = v => (v === null ? null : Buffer.isBuffer(v) ? `[BLOB ${v.length} byte]` : v instanceof Date ? v.toISOString().replace('T', ' ').slice(0, 19)
      : typeof v === 'string' && v.length > 2000 ? `${v.slice(0, 2000)}… (${v.length} ký tự)` : v);
    res.json({
      table, page, per, total: Number(total), sort, dir: dir.toLowerCase(),
      columns: cols.map(c => ({ name: c.name, type: c.type, key: c.k })),
      rows: rows.map(row => names.map(n => cell(row[n]))),
    });
  }));

  // Xuất database thành tệp .sql tải về
  r.get('/:db/export', wrap(async (req, res) => {
    const db = checkDb(req.params.db);
    if (!(await D.dbExists(db))) throw httpError(404, 'Không tìm thấy database.');
    res.setHeader('Content-Type', 'application/sql; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${db.replace(/[^A-Za-z0-9_.-]/g, '_')}-${stamp()}.sql"`);
    try { await D.dump(db, res); } catch (e) { if (!res.headersSent) throw e; res.end(`\n-- Lỗi: ${e.message}\n`); }
  }));

  // Nhập tệp .sql / .sql.gz vào database (tạo database nếu chưa có; tùy chọn xóa sạch dữ liệu cũ trước)
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => { const d = path.join(config.paths.tools, 'uploads'); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
      filename: (req, file, cb) => cb(null, `${crypto.randomBytes(8).toString('hex')}${/\.gz$/i.test(file.originalname) ? '.sql.gz' : '.sql'}`),
    }),
    limits: { fileSize: 20 * 1024 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(/\.sql(\.gz)?$/i.test(file.originalname) ? null : httpError(400, 'Chỉ nhận tệp .sql hoặc .sql.gz.'), true),
  });
  r.post('/:db/import', upload.single('file'), wrap(async (req, res) => {
    const db = checkDb(req.params.db);
    if (!req.file) throw httpError(400, 'Chưa chọn tệp.');
    if (D.SYSTEM_DBS.includes(db.toLowerCase())) { fs.rmSync(req.file.path, { force: true }); throw httpError(400, 'Không nhập vào database hệ thống.'); }
    const replace = req.body?.replace === '1';
    const file = req.file.path;
    const id = jobs.start(`Nhập ${req.file.originalname} vào ${db}`, async ctx => {
      try {
        if (replace) { ctx.step(`Xóa sạch database ${db}`); await D.query(`DROP DATABASE IF EXISTS ${q(db)}`); }
        await D.query(`CREATE DATABASE IF NOT EXISTS ${q(db)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        ctx.step(`Nạp ${req.file.originalname} (${D.mb(fs.statSync(file).size)})`);
        const { completed } = await D.importFile(file, db, ctx);
        return { db, notes: completed ? [] : ['Tệp không có dòng "Dump completed" ở cuối; có thể tệp bị cắt dở.'] };
      } finally { fs.rmSync(file, { force: true }); }
    });
    res.json({ ok: true, job: id });
  }));

  return { router: r };
};
