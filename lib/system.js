// Thông tin hệ thống cho ứng dụng desktop: chạy cùng Windows, tắt panel
const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { wrap, httpError } = require('./util');

const isWin = process.platform === 'win32';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const reg = args => new Promise(resolve => {
  execFile('reg', args, { windowsHide: true }, (err, out) => resolve({ ok: !err, out: out || '' }));
});

module.exports = (config) => {
  const r = express.Router();
  const ROOT = path.resolve(__dirname, '..');
  const exe = path.join(ROOT, 'EzPanel.exe');

  async function autorun() {
    if (!isWin) return false;
    // Bản cũ ghi khóa tên "LocalPanel": xóa đi, giữ lựa chọn của người dùng bằng khóa EzPanel
    const legacy = await reg(['query', RUN_KEY, '/v', 'LocalPanel']);
    if (legacy.ok && fs.existsSync(exe)) {
      await reg(['delete', RUN_KEY, '/v', 'LocalPanel', '/f']);
      await reg(['add', RUN_KEY, '/v', 'EzPanel', '/t', 'REG_SZ', '/d', `"${exe}" --background`, '/f']);
    }
    const q = await reg(['query', RUN_KEY, '/v', 'EzPanel']);
    return q.ok && q.out.toLowerCase().includes('tpanel.exe');
  }

  r.get('/', wrap(async (req, res) => {
    res.json({
      windows: isWin,
      desktopApp: fs.existsSync(exe),
      tray: process.env.LOCALPANEL_TRAY === '1',
      autorun: await autorun(),
    });
  }));

  // Chạy cùng Windows: ghi/xóa khóa Run của người dùng hiện tại (không cần quyền admin)
  r.post('/autorun', wrap(async (req, res) => {
    if (!isWin) throw httpError(400, 'Chỉ dùng được trên Windows.');
    if (!fs.existsSync(exe)) throw httpError(400, 'Chưa có EzPanel.exe. Chạy setup.cmd để tạo ứng dụng desktop trước.');
    const out = req.body?.on
      ? await reg(['add', RUN_KEY, '/v', 'EzPanel', '/t', 'REG_SZ', '/d', `"${exe}" --background`, '/f'])
      : await reg(['delete', RUN_KEY, '/v', 'EzPanel', '/f']);
    if (!out.ok && req.body?.on) throw httpError(500, 'Không ghi được vào registry.');
    res.json({ ok: true, autorun: await autorun() });
  }));

  r.post('/shutdown', wrap(async (req, res) => {
    res.json({ ok: true });
    req.app.locals.shutdown?.(!!req.body?.stopServices);
  }));

  return r;
};
