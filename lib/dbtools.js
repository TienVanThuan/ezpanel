// Công cụ database dùng chung: xuất (mysqldump), nạp tệp .sql/.sql.gz (mysql client của Laragon),
// và nhận biết database của một dự án (wp-config.php, .env của Laravel, thông tin lưu kèm).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Transform } = require('stream');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const { httpError } = require('./util');

const isWin = process.platform === 'win32';
const EXE = isWin ? '.exe' : '';
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const mb = n => `${(n / 1048576).toFixed(n > 104857600 ? 0 : 1)} MB`;
const SYSTEM_DBS = ['mysql', 'information_schema', 'performance_schema', 'sys'];

module.exports = (config, { laragon }) => {
  function client(name) {
    const bin = laragon.detected() ? laragon.mysqlBin() : null;
    const exe = bin && path.join(bin, `${name}${EXE}`);
    if (!exe || !exists(exe)) throw httpError(400, `Không tìm thấy ${name} trong Laragon.`);
    return exe;
  }
  const connArgs = () => ['-h', config.mysql.host, '-P', String(config.mysql.port), '-u', config.mysql.user];
  const connEnv = () => ({ ...process.env, MYSQL_PWD: config.mysql.password || '' });

  // dateStrings: ngày giờ đọc nguyên văn (kể cả 0000-00-00 của WordPress), không đổi múi giờ
  async function query(sql, params, database) {
    let c;
    try { c = await mysql.createConnection({ ...config.mysql, database, charset: 'utf8mb4', connectTimeout: 4000, dateStrings: true }); } catch (e) {
      throw httpError(502, `Không kết nối được MySQL (${e.message}). Bật MySQL trong mục Máy chủ & dự án rồi thử lại.`);
    }
    try { return (await c.query(sql, params))[0]; } finally { c.end().catch(() => {}); }
  }
  const dbExists = async name => (await query('SHOW DATABASES LIKE ?', [name])).length > 0;

  // Xuất database ra luồng ghi (tệp hoặc phản hồi HTTP)
  function dump(db, out, onBytes) {
    return new Promise((resolve, reject) => {
      let exe;
      try { exe = client('mysqldump'); } catch (e) { return reject(e); }
      const child = spawn(exe, [...connArgs(), '--default-character-set=utf8mb4', '--single-transaction', '--quick',
        '--routines', '--triggers', '--add-drop-table', '--no-tablespaces', db], { env: connEnv(), windowsHide: true });
      let err = '';
      child.stderr.on('data', d => { err += d; });
      child.stdout.on('data', d => onBytes?.(d.length));
      child.stdout.pipe(out);
      child.on('error', reject);
      child.on('close', code => {
        if (code !== 0) return reject(httpError(500, `Xuất database ${db} thất bại: ${err.split(/\r?\n/).filter(l => l && !/Using a password/i.test(l)).slice(-2).join(' ') || `mã ${code}`}`));
        resolve();
      });
    });
  }
  async function dumpToFile(db, file, ctx) {
    const out = fs.createWriteStream(file);
    let got = 0, last = 0;
    await dump(db, out, n => {
      got += n;
      if (ctx && got - last > 20 * 1048576) { ctx.log(`  đã xuất ${mb(got)}`); last = got; }
    });
    await new Promise(r => (out.writableFinished ? r() : out.on('finish', r)));
  }

  // Nạp tệp .sql / .sql.gz vào database (bỏ CREATE DATABASE / USE để dữ liệu chỉ vào đúng database)
  async function importFile(file, db, ctx) {
    const exe = client('mysql');
    const total = fs.statSync(file).size;
    let read = 0, completed = false, rest = '', dropped = 0;
    const filter = new Transform({
      transform(chunk, enc, cb) {
        const parts = (rest + chunk.toString('utf8')).split('\n');
        rest = parts.pop();
        cb(null, parts.map(l => {
          if (/^-- Dump completed/.test(l)) completed = true;
          if (/^\s*(CREATE DATABASE|USE\s+`?)/i.test(l)) { dropped++; return '-- [Sitebench] ' + l.slice(0, 200); }
          return l;
        }).join('\n') + (parts.length ? '\n' : ''));
      },
      flush(cb) {
        if (/^-- Dump completed/.test(rest)) completed = true;
        cb(null, rest);
      },
    });
    const child = spawn(exe, [...connArgs(), '--default-character-set=utf8mb4', '--max_allowed_packet=1073741824', db], {
      env: connEnv(), windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    const input = fs.createReadStream(file);
    input.on('data', d => { read += d.length; ctx?.progress((read / total) * 100); });
    let last = 0;
    const timer = setInterval(() => { if (ctx && read - last > 0) { ctx.log(`  đã nạp ${mb(read)} / ${mb(total)}`); last = read; } }, 5000);
    const src = /\.gz$/i.test(file) ? input.pipe(zlib.createGunzip()) : input;
    src.on('error', e => child.stdin.destroy(e));
    src.pipe(filter).pipe(child.stdin);
    child.stdin.on('error', () => { /* mysql đã thoát, lỗi đọc ở stderr */ });
    const code = await new Promise(resolve => child.on('close', resolve));
    clearInterval(timer);
    if (code !== 0) {
      const msg = err.split(/\r?\n/).filter(l => l && !/Using a password/i.test(l)).slice(-2).join(' ');
      throw httpError(400, `Nạp database thất bại: ${msg || `mysql thoát với mã ${code}`}`);
    }
    if (dropped && ctx) ctx.log(`  bỏ qua ${dropped} lệnh CREATE DATABASE/USE trong tệp`);
    return { completed };
  }

  // Database của dự án: wp-config.php (WordPress), .env (Laravel), hoặc thông tin lưu kèm
  function readDefine(src, key) {
    const m = new RegExp(`define\\s*\\(\\s*['"]${key}['"]\\s*,\\s*(?:'((?:\\\\.|[^'\\\\])*)'|"((?:\\\\.|[^"\\\\])*)")`, 'i').exec(src || '');
    return m ? (m[1] ?? m[2]).replace(/\\(['"\\])/g, '$1') : null;
  }
  function projectDb(dir, meta) {
    try {
      const wp = path.join(dir, 'wp-config.php');
      if (exists(wp)) {
        const db = readDefine(fs.readFileSync(wp, 'utf8'), 'DB_NAME');
        if (db) return { name: db, from: 'wp-config.php' };
      }
      const env = path.join(dir, '.env');
      if (exists(env)) {
        const text = fs.readFileSync(env, 'utf8');
        const conn = (/^DB_CONNECTION=(.*)$/m.exec(text) || [])[1]?.trim();
        const db = (/^DB_DATABASE=(.*)$/m.exec(text) || [])[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
        if (db && (!conn || /mysql|mariadb/i.test(conn))) return { name: db, from: '.env' };
      }
    } catch { /* bỏ qua */ }
    if (meta?.db) return { name: meta.db, from: 'Sitebench' };
    return null;
  }
  const kindOf = dir => (exists(path.join(dir, 'wp-includes', 'version.php')) || exists(path.join(dir, 'wp-config.php')) ? 'wordpress'
    : exists(path.join(dir, 'artisan')) ? 'laravel' : 'php');

  return { query, dbExists, dump, dumpToFile, importFile, projectDb, kindOf, readDefine, SYSTEM_DBS, mb };
};
