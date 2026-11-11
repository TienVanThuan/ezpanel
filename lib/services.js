const express = require('express');
const { execFile } = require('child_process');
const { wrap, httpError } = require('./util');

const isWindows = process.platform === 'win32';
const SERVICE_NAME = /^[A-Za-z0-9_.$ -]{1,80}$/;
const STATES = { 1: 'stopped', 2: 'starting', 3: 'stopping', 4: 'running', 5: 'continuing', 6: 'pausing', 7: 'paused' };

// Gọi sc.exe bằng execFile (không qua shell) để tránh chèn lệnh
const sc = args => new Promise(resolve => {
  execFile('sc', args, { windowsHide: true, timeout: 20000 }, (err, stdout, stderr) => {
    resolve({ failed: !!err, out: `${stdout || ''}${stderr || ''}` });
  });
});

async function query(name) {
  const { out } = await sc(['query', name]);
  const m = /STATE\s*:\s*(\d+)/.exec(out);
  if (!m) return { name, state: 'missing' };
  const disp = await sc(['GetDisplayName', name]);
  const d = /=\s*(.+)\s*$/m.exec(disp.out);
  return { name, state: STATES[m[1]] || 'unknown', displayName: d ? d[1].trim() : null };
}

function explain(out) {
  if (/FAILED 5:|\b5\b.*denied/i.test(out)) return 'Cần chạy EzPanel bằng quyền Administrator để bật/tắt dịch vụ.';
  if (/FAILED 1056/.test(out)) return 'Dịch vụ đang chạy rồi.';
  if (/FAILED 1062/.test(out)) return 'Dịch vụ chưa chạy.';
  if (/FAILED 1060/.test(out)) return 'Không có dịch vụ nào tên này trên máy.';
  if (/FAILED 1058/.test(out)) return 'Dịch vụ đang bị vô hiệu hóa (Disabled) trong Windows.';
  return out.trim().split(/\r?\n/).pop() || 'Thao tác thất bại.';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(name, state, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    if ((await query(name)).state === state) return true;
  }
  return false;
}

module.exports = (config) => {
  const r = express.Router();
  const watched = name => {
    if (!config.services.includes(name)) throw httpError(404, 'Dịch vụ này chưa có trong danh sách theo dõi.');
    return name;
  };

  r.get('/', wrap(async (req, res) => {
    if (!isWindows) return res.json({ supported: false, services: config.services.map(name => ({ name, state: 'unknown' })) });
    res.json({ supported: true, services: await Promise.all(config.services.map(query)) });
  }));

  r.post('/', wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!SERVICE_NAME.test(name)) throw httpError(400, 'Tên dịch vụ không hợp lệ.');
    if (config.services.includes(name)) throw httpError(409, 'Dịch vụ đã có trong danh sách.');
    config.services.push(name);
    config.save();
    res.json({ ok: true });
  }));

  r.delete('/:name', wrap(async (req, res) => {
    const name = watched(req.params.name);
    config.services = config.services.filter(s => s !== name);
    config.save();
    res.json({ ok: true });
  }));

  r.post('/:name/:action', wrap(async (req, res) => {
    if (!isWindows) throw httpError(400, 'Quản lý dịch vụ chỉ hoạt động trên Windows.');
    const name = watched(req.params.name);
    const action = req.params.action;
    if (!['start', 'stop', 'restart'].includes(action)) throw httpError(400, 'Thao tác không hợp lệ.');

    if (action === 'stop' || action === 'restart') {
      const r1 = await sc(['stop', name]);
      if (r1.failed && !(action === 'restart' && /FAILED 1062/.test(r1.out))) throw httpError(400, explain(r1.out));
      if (action === 'restart' && !(await waitFor(name, 'stopped'))) throw httpError(504, 'Dịch vụ không dừng kịp trong 15 giây.');
    }
    if (action === 'start' || action === 'restart') {
      const r2 = await sc(['start', name]);
      if (r2.failed) throw httpError(400, explain(r2.out));
    }
    await waitFor(name, action === 'stop' ? 'stopped' : 'running', 8000);
    res.json({ ok: true, service: await query(name) });
  }));

  return r;
};
