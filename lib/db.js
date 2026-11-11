const express = require('express');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const mysql = require('mysql2/promise');
const { wrap, httpError } = require('./util');

const MAX_ROWS = 1000;
const MYSQL_SYSTEM_DBS = ['mysql', 'information_schema', 'performance_schema', 'sys'];

// Chuyển giá trị nhị phân thành chuỗi mô tả để trả về JSON
const cell = v => (v instanceof Uint8Array || Buffer.isBuffer(v)) ? `[BLOB ${v.length} byte]` : v;

module.exports = (config) => {
  const r = express.Router();

  // ===================== SQLite =====================
  const dir = config.paths.sqlite;
  const SQLready = initSqlJs();
  const SQLITE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

  const sqliteFile = name => {
    if (!SQLITE_NAME.test(name)) throw httpError(400, 'Tên database chỉ gồm chữ không dấu, số, _ và -.');
    return path.join(dir, `${name}.sqlite`);
  };
  async function openSqlite(name) {
    const file = sqliteFile(name);
    if (!fs.existsSync(file)) throw httpError(404, 'Không tìm thấy database.');
    const SQL = await SQLready;
    return { db: new SQL.Database(fs.readFileSync(file)), file };
  }

  r.get('/sqlite', wrap(async (req, res) => {
    const list = fs.readdirSync(dir)
      .filter(f => f.endsWith('.sqlite'))
      .map(f => ({ name: f.slice(0, -7), size: fs.statSync(path.join(dir, f)).size }));
    res.json({ databases: list, dir });
  }));

  r.post('/sqlite', wrap(async (req, res) => {
    const file = sqliteFile(String(req.body?.name || ''));
    if (fs.existsSync(file)) throw httpError(409, 'Database này đã tồn tại.');
    const SQL = await SQLready;
    const db = new SQL.Database();
    fs.writeFileSync(file, Buffer.from(db.export()));
    db.close();
    res.json({ ok: true });
  }));

  r.delete('/sqlite/:name', wrap(async (req, res) => {
    const file = sqliteFile(req.params.name);
    fs.rmSync(file, { force: true });
    res.json({ ok: true });
  }));

  r.get('/sqlite/:name/tables', wrap(async (req, res) => {
    const { db } = await openSqlite(req.params.name);
    try {
      const out = db.exec("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name");
      res.json({ tables: out.length ? out[0].values.map(v => v[0]) : [] });
    } finally { db.close(); }
  }));

  r.post('/sqlite/:name/query', wrap(async (req, res) => {
    const sql = String(req.body?.sql || '').trim();
    if (!sql) throw httpError(400, 'Hãy nhập câu lệnh SQL.');
    const { db, file } = await openSqlite(req.params.name);
    try {
      let results;
      try { results = db.exec(sql); } catch (e) { throw httpError(400, e.message); }
      const changes = db.getRowsModified();
      const readOnly = /^\s*(select|pragma|explain)\b/i.test(sql);
      if (!readOnly || changes > 0) fs.writeFileSync(file, Buffer.from(db.export()));
      res.json({
        changes,
        results: results.map(x => ({
          columns: x.columns,
          rows: x.values.slice(0, MAX_ROWS).map(row => row.map(cell)),
          total: x.values.length,
        })),
      });
    } finally { db.close(); }
  }));

  // ===================== MySQL / MariaDB =====================
  // Tên database mới: chữ, số, _, -, $ (đủ cho cách đặt tên của Laragon, XAMPP…)
  const MYSQL_NEW_NAME = /^[A-Za-z0-9_$-]{1,64}$/;
  // Đặt tên trong dấu ` và nhân đôi ` bên trong, để dùng an toàn với mọi tên có sẵn
  const ident = name => '`' + name.replace(/`/g, '``') + '`';
  const connect = (database, multi = false) => mysql.createConnection({
    ...config.mysql,
    database,
    multipleStatements: multi, // chỉ bật cho tab SQL (người dùng tự gõ nhiều câu lệnh)
    charset: 'utf8mb4',
    connectTimeout: 4000,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  async function withConn(database, fn) {
    let conn;
    try { conn = await connect(database); } catch (e) {
      throw httpError(502, `Không kết nối được MySQL: ${e.message}`);
    }
    try { return await fn(conn); } finally { conn.end().catch(() => {}); }
  }
  // Database đã có: chấp nhận mọi tên MySQL cho phép (kể cả có dấu - hoặc .)
  const checkName = name => {
    if (!name || name.length > 64 || /[\x00/\\]/.test(name) || name !== name.trimEnd()) {
      throw httpError(400, 'Tên database không hợp lệ.');
    }
    return name;
  };
  const checkNewName = name => {
    if (!MYSQL_NEW_NAME.test(name)) throw httpError(400, 'Tên database mới chỉ gồm chữ không dấu, số, _, - và $.');
    return name;
  };

  r.get('/mysql', wrap(async (req, res) => {
    const { password, ...shown } = config.mysql;
    let conn;
    try { conn = await connect(); } catch (e) {
      return res.json({ connected: false, error: e.message, config: shown });
    }
    try {
      const [[{ v }]] = await conn.query('SELECT VERSION() AS v');
      const [rows] = await conn.query('SHOW DATABASES');
      res.json({
        connected: true,
        version: v,
        config: shown,
        databases: rows.map(x => ({ name: x.Database, system: MYSQL_SYSTEM_DBS.includes(x.Database.toLowerCase()) })),
      });
    } finally { conn.end().catch(() => {}); }
  }));

  r.post('/mysql/config', wrap(async (req, res) => {
    const { host, port, user, password } = req.body || {};
    if (!host || !user) throw httpError(400, 'Cần nhập host và user.');
    config.mysql = {
      host: String(host),
      port: Number(port) || 3306,
      user: String(user),
      // Để trống ô mật khẩu = giữ mật khẩu cũ
      password: password === undefined || password === null ? config.mysql.password : String(password),
    };
    config.save();
    res.json({ ok: true });
  }));

  r.post('/mysql', wrap(async (req, res) => {
    const name = checkNewName(String(req.body?.name || ''));
    await withConn(undefined, c => c.query(`CREATE DATABASE ${ident(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`))
      .catch(e => { throw e.status ? e : httpError(400, e.message); });
    res.json({ ok: true });
  }));

  r.delete('/mysql/:name', wrap(async (req, res) => {
    const name = checkName(req.params.name);
    if (MYSQL_SYSTEM_DBS.includes(name.toLowerCase())) throw httpError(400, 'Không được xóa database hệ thống.');
    await withConn(undefined, c => c.query(`DROP DATABASE ${ident(name)}`))
      .catch(e => { throw e.status ? e : httpError(400, e.message); });
    res.json({ ok: true });
  }));

  r.get('/mysql/:name/tables', wrap(async (req, res) => {
    const name = checkName(req.params.name);
    const tables = await withConn(name, async c => {
      const [rows] = await c.query('SHOW TABLES');
      return rows.map(row => Object.values(row)[0]);
    });
    res.json({ tables });
  }));

  r.post('/mysql/:name/query', wrap(async (req, res) => {
    const name = checkName(req.params.name);
    const sql = String(req.body?.sql || '').trim();
    if (!sql) throw httpError(400, 'Hãy nhập câu lệnh SQL.');
    let c;
    try { c = await connect(name, true); } catch (e) { throw httpError(502, `Không kết nối được MySQL: ${e.message}`); }
    try {
      let rows, fields;
      try { [rows, fields] = await c.query({ sql, rowsAsArray: true }); } catch (e) { throw httpError(400, e.message); }
      // Nhiều câu lệnh: fields là mảng theo từng câu (mảng cột với SELECT, undefined với INSERT/UPDATE…)
      const multi = Array.isArray(fields) && fields.length > 0 && (fields[0] === undefined || Array.isArray(fields[0]));
      const sets = multi ? fields.map((f, i) => [rows[i], f]) : [[rows, fields]];
      const out = { changes: 0, results: [], statements: sets.length };
      for (const [r, f] of sets) {
        if (Array.isArray(r) && f) {
          out.results.push({ columns: f.map(x => x.name), rows: r.slice(0, MAX_ROWS).map(row => row.map(cell)), total: r.length });
        } else if (r && typeof r === 'object') {
          out.changes += r.affectedRows || 0;
          if (r.insertId) out.insertId = r.insertId;
        }
      }
      res.json(out);
    } finally { c.end().catch(() => {}); }
  }));

  return r;
};
