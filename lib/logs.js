// Xem nhật ký (log) trực tiếp: Apache, PHP, MySQL, php-cgi, Mailpit, EzPanel và log của từng dự án
// (debug.log của WordPress, storage/logs của Laravel, tệp error_log kiểu cPanel).
// Trình duyệt chỉ mở log theo mã (id) do máy chủ cấp, không truyền đường dẫn tùy ý.

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { wrap, httpError } = require('./util');

const exists = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const TAIL_BYTES = 128 * 1024;
const MAX_CHUNK = 512 * 1024;

module.exports = (config, { laragon }) => {
  const r = express.Router();

  // Giá trị error_log trong php.ini của PHP mặc định
  function phpErrorLog() {
    try {
      const folder = laragon.defaultPhp();
      if (!folder) return null;
      const ini = fs.readFileSync(path.join(laragon.phpDir(folder), 'php.ini'), 'utf8');
      const m = /^\s*error_log\s*=\s*"?([^"\r\n;]+)"?/mi.exec(ini);
      if (!m) return null;
      const p = m[1].trim();
      return path.isAbsolute(p) ? p : path.join(laragon.phpDir(folder), p);
    } catch { return null; }
  }

  function mysqlErrLogs() {
    const out = [];
    const dataRoot = path.join(laragon.P.root(), 'data');
    let dirs = [];
    try { dirs = fs.readdirSync(dataRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(dataRoot, d.name)); } catch { return out; }
    for (const d of dirs) {
      try {
        for (const f of fs.readdirSync(d)) if (f.endsWith('.err')) out.push(path.join(d, f));
      } catch { /* bỏ qua */ }
    }
    return out;
  }

  function newestLogs(dir, limit) {
    try {
      return fs.readdirSync(dir).filter(f => f.endsWith('.log')).map(f => path.join(dir, f))
        .map(f => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, limit).map(x => x.f);
    } catch { return []; }
  }

  // Danh sách nguồn log hiện có
  function sources() {
    const list = [];
    const add = (group, label, file, hint) => {
      if (file && exists(file) && !list.some(x => x.path === path.resolve(file))) list.push({ group, label, path: path.resolve(file), hint });
    };
    const logs = config.paths.logs;
    add('EzPanel', 'EzPanel', path.join(logs, 'localpanel.log'));
    add('EzPanel', 'php-cgi (PHP riêng của dự án)', path.join(logs, 'php-cgi.log'));
    add('EzPanel', 'Mailpit', path.join(logs, 'mailpit.log'));
    if (laragon.detected()) {
      const a = laragon.apache();
      if (a) {
        add('Máy chủ', 'Apache: lỗi', path.join(a.dir, 'logs', 'error.log'));
        add('Máy chủ', 'Apache: truy cập', path.join(a.dir, 'logs', 'access.log'));
        add('Máy chủ', 'Apache: SSL', path.join(a.dir, 'logs', 'ssl_error.log'));
      }
      add('Máy chủ', 'PHP: lỗi', phpErrorLog());
      for (const f of mysqlErrLogs()) add('Máy chủ', `MySQL: ${path.basename(path.dirname(f))}`, f);
      for (const p of laragon.projects()) {
        const dir = laragon.projectDir(p.name);
        const g = `Dự án: ${p.name}`;
        add(g, 'WordPress debug.log', path.join(dir, 'wp-content', 'debug.log'));
        for (const f of newestLogs(path.join(dir, 'storage', 'logs'), 3)) add(g, `Laravel: ${path.basename(f)}`, f);
        add(g, 'error_log', path.join(dir, 'error_log'));
        add(g, 'error_log (wp-admin)', path.join(dir, 'wp-admin', 'error_log'));
        add(g, 'error_log (public)', path.join(dir, 'public', 'error_log'));
      }
    }
    return list.map(x => {
      const st = fs.statSync(x.path);
      return { ...x, id: crypto.createHash('sha1').update(x.path).digest('hex').slice(0, 16), size: st.size, mtime: st.mtimeMs };
    });
  }
  const find = id => {
    const s = sources().find(x => x.id === id);
    if (!s) throw httpError(404, 'Không tìm thấy tệp log này (có thể đã bị xóa).');
    return s;
  };

  async function readRange(file, start, end) {
    const fh = await fsp.open(file, 'r');
    try {
      const len = Math.max(0, end - start);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, start);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally { await fh.close(); }
  }
  async function tail(file, size) {
    const start = Math.max(0, size - TAIL_BYTES);
    let text = await readRange(file, start, size);
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // bỏ dòng bị cắt dở
    return { text, truncated: start > 0 };
  }

  // ---------- API ----------
  r.get('/', wrap(async (req, res) => {
    res.json({ sources: sources(), wpDebugHint: laragon.detected() });
  }));

  // Theo dõi trực tiếp bằng Server-Sent Events
  r.get('/:id/stream', wrap(async (req, res) => {
    const src = find(req.params.id);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let size = fs.statSync(src.path).size;
    send('init', { ...(await tail(src.path, size)), size });
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const now = fs.statSync(src.path).size;
        if (now < size) {
          // Tệp bị xóa nội dung hoặc xoay vòng
          size = now;
          send('reset', { ...(await tail(src.path, now)), size: now });
        } else if (now > size) {
          const end = Math.min(now, size + MAX_CHUNK);
          const text = await readRange(src.path, size, end);
          size = end;
          send('append', { text, size });
        }
      } catch (e) {
        send('gone', { message: 'Tệp log không còn đọc được.' });
        clearInterval(timer);
        res.end();
      } finally { busy = false; }
    }, 1000);
    const keep = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(timer); clearInterval(keep); });
  }));

  r.post('/:id/clear', wrap(async (req, res) => {
    const src = find(req.params.id);
    try { await fsp.truncate(src.path, 0); } catch (e) {
      throw httpError(409, e.code === 'EBUSY' || e.code === 'EPERM'
        ? 'Tệp đang bị chương trình khác giữ (thường là Apache hoặc MySQL). Tắt dịch vụ đó rồi thử lại.'
        : `Không xóa được nội dung: ${e.message}`);
    }
    res.json({ ok: true });
  }));

  r.get('/:id/download', wrap(async (req, res) => {
    const src = find(req.params.id);
    res.download(src.path);
  }));

  return { router: r };
};
