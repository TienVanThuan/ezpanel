const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const multer = require('multer');
const { wrap, httpError } = require('./util');

const MAX_EDIT_SIZE = 2 * 1024 * 1024; // chỉ mở file < 2 MB trong trình soạn thảo

module.exports = (config) => {
  const root = config.paths.files;
  const r = express.Router();

  // Chuyển đường dẫn tương đối thành tuyệt đối, chặn mọi truy cập ra ngoài thư mục gốc
  function resolve(p = '') {
    const clean = String(p).replace(/^[\\/]+/, '');
    const full = path.resolve(root, clean);
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw httpError(400, 'Đường dẫn nằm ngoài thư mục được quản lý.');
    }
    return full;
  }
  const rel = full => path.relative(root, full).split(path.sep).join('/');
  const validName = name => {
    if (!name || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') {
      throw httpError(400, 'Tên không hợp lệ. Không dùng các ký tự \\ / : * ? " < > |');
    }
    return name;
  };

  r.get('/list', wrap(async (req, res) => {
    const dir = resolve(req.query.path);
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => {
      throw httpError(404, 'Không tìm thấy thư mục.');
    });
    const items = await Promise.all(entries.map(async d => {
      const st = await fsp.stat(path.join(dir, d.name)).catch(() => null);
      return { name: d.name, dir: d.isDirectory(), size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 };
    }));
    items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'vi'));
    res.json({ path: rel(dir), root, items });
  }));

  r.get('/read', wrap(async (req, res) => {
    const file = resolve(req.query.path);
    const st = await fsp.stat(file).catch(() => { throw httpError(404, 'Không tìm thấy tệp.'); });
    if (st.isDirectory()) throw httpError(400, 'Đây là thư mục, không phải tệp.');
    if (st.size > MAX_EDIT_SIZE) throw httpError(413, 'Tệp lớn hơn 2 MB, hãy tải về để chỉnh sửa.');
    res.json({ path: rel(file), content: await fsp.readFile(file, 'utf8') });
  }));

  r.post('/write', wrap(async (req, res) => {
    const { path: p, content } = req.body || {};
    if (typeof content !== 'string') throw httpError(400, 'Thiếu nội dung tệp.');
    const file = resolve(p);
    if (file === root) throw httpError(400, 'Cần tên tệp.');
    validName(path.basename(file));
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content, 'utf8');
    res.json({ ok: true });
  }));

  r.post('/mkdir', wrap(async (req, res) => {
    const dir = resolve(req.body?.path);
    validName(path.basename(dir));
    await fsp.mkdir(dir, { recursive: true });
    res.json({ ok: true });
  }));

  r.post('/rename', wrap(async (req, res) => {
    const from = resolve(req.body?.from);
    const to = resolve(req.body?.to);
    if (from === root) throw httpError(400, 'Không thể đổi tên thư mục gốc.');
    validName(path.basename(to));
    if (fs.existsSync(to)) throw httpError(409, 'Đã có tệp hoặc thư mục trùng tên.');
    await fsp.rename(from, to);
    res.json({ ok: true });
  }));

  r.post('/delete', wrap(async (req, res) => {
    const target = resolve(req.body?.path);
    if (target === root) throw httpError(400, 'Không thể xóa thư mục gốc.');
    await fsp.rm(target, { recursive: true, force: true });
    res.json({ ok: true });
  }));

  r.get('/download', wrap(async (req, res) => {
    const file = resolve(req.query.path);
    const st = await fsp.stat(file).catch(() => { throw httpError(404, 'Không tìm thấy tệp.'); });
    if (st.isDirectory()) throw httpError(400, 'Chỉ tải về được tệp, không tải được thư mục.');
    res.download(file);
  }));

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        try { cb(null, resolve(req.query.path)); } catch (e) { cb(e); }
      },
      filename: (req, file, cb) => {
        // multer đọc tên tệp theo latin1 – chuyển lại UTF-8 để giữ tiếng Việt
        const name = path.basename(Buffer.from(file.originalname, 'latin1').toString('utf8'));
        try { cb(null, validName(name)); } catch (e) { cb(e); }
      },
    }),
    limits: { fileSize: 512 * 1024 * 1024 },
  });
  r.post('/upload', upload.array('files'), (req, res) => {
    res.json({ ok: true, count: req.files.length });
  });

  return r;
};
