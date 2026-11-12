// Tác vụ nền cho các thao tác lâu (nhập site, tải phần mềm…).
// Trình duyệt hỏi tiến độ định kỳ qua GET /api/jobs/:id.

const express = require('express');
const crypto = require('crypto');
const { httpError } = require('./util');

const KEEP = 30;

module.exports = () => {
  const jobs = new Map();

  // fn(ctx) với ctx.log(dòng), ctx.step(tên bước), ctx.progress(0–100 hoặc null)
  function start(title, fn) {
    const id = crypto.randomBytes(8).toString('hex');
    const job = { id, title, status: 'running', step: 'Đang chuẩn bị…', progress: null, log: [], result: null, error: null, started: Date.now(), ended: null };
    jobs.set(id, job);
    const ctx = {
      log: line => { job.log.push(`${new Date().toLocaleTimeString('vi-VN')}  ${line}`); if (job.log.length > 500) job.log.splice(0, job.log.length - 500); },
      step: s => { job.step = s; ctx.log(s); job.progress = null; },
      progress: p => { job.progress = p == null ? null : Math.max(0, Math.min(100, Math.round(p))); },
    };
    Promise.resolve().then(() => fn(ctx)).then(result => {
      job.status = 'done';
      job.result = result || null;
      job.step = 'Hoàn tất';
      job.progress = 100;
    }, err => {
      job.status = 'failed';
      job.error = err.message || String(err);
      ctx.log(`Lỗi: ${job.error}`);
    }).finally(() => {
      job.ended = Date.now();
      // Chỉ giữ các tác vụ gần đây
      const done = [...jobs.values()].filter(j => j.status !== 'running').sort((a, b) => a.ended - b.ended);
      while (done.length > KEEP) jobs.delete(done.shift().id);
    });
    return id;
  }

  const r = express.Router();
  r.get('/:id', (req, res, next) => {
    const job = jobs.get(req.params.id);
    if (!job) return next(httpError(404, 'Không tìm thấy tác vụ (có thể Sitebench đã khởi động lại).'));
    const since = Number(req.query.since) || 0;
    res.json({ ...job, log: job.log.slice(since), logTotal: job.log.length });
  });
  r.get('/', (req, res) => {
    res.json({ jobs: [...jobs.values()].filter(j => j.status === 'running').map(({ id, title, step }) => ({ id, title, step })) });
  });

  return { router: r, start, running: () => [...jobs.values()].some(j => j.status === 'running') };
};
