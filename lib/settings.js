// Trang Cài đặt: chế độ máy chủ (Laragon / độc lập), cổng, thông tin ứng dụng, khởi động lại Sitebench.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { wrap, httpError } = require('./util');

const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const fwd = p => p.split(path.sep).join('/');
const ROOT = path.resolve(__dirname, '..');
const validPort = p => Number.isInteger(p) && p >= 1 && p <= 65535;

// Cổng MySQL khác 3306: mọi bản PHP (qua PHP_INI_SCAN_DIR của Sitebench) kết nối "localhost" tới đúng cổng,
// nên WordPress (DB_HOST = 'localhost') không phải sửa wp-config.php
function writeMysqlPortIni(config) {
  const file = path.join(config.paths.phpIni, 'tpanel-mysql.ini');
  const port = Number(config.mysql.port) || 3306;
  if (port === 3306) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(config.paths.phpIni, { recursive: true });
  fs.writeFileSync(file, `; Do Sitebench tạo: MySQL chạy ở cổng ${port}\r\nmysqli.default_port = ${port}\r\n`);
}

module.exports = (config, { laragon, services, runtime, jobs }) => {
  const r = express.Router();
  const L = config.laragon;
  writeMysqlPortIni(config);
  // Nhớ thư mục của từng chế độ để chuyển qua lại không mất gì
  config.roots = { ...(config.roots || {}) };
  if (L.root) config.roots[config.mode === 'standalone' ? 'standalone' : 'laragon'] = L.root;
  const isStandaloneRoot = d => !!d && exists(path.join(d, 'usr', 'tpanel.ini')) && exists(path.join(d, 'www'));
  const isLaragonRoot = d => !!d && exists(path.join(d, 'www')) && exists(path.join(d, 'bin', 'php')) && !exists(path.join(d, 'usr', 'tpanel.ini'));
  const version = (() => { try { return require(path.join(ROOT, 'package.json')).version; } catch { return '?'; } })();

  r.get('/', wrap(async (req, res) => {
    const standalone = config.mode === 'standalone';
    res.json({
      version, appDir: fwd(ROOT), mode: standalone ? 'standalone' : 'laragon', root: L.root, roots: config.roots,
      standaloneReady: isStandaloneRoot(config.roots.standalone),
      laragonFound: runtime.findLaragon(),
      panelPort: config.port, httpPort: Number(L.httpPort) || 80, mysqlPort: Number(config.mysql.port) || 3306,
      tray: process.env.LOCALPANEL_TRAY === '1',
      installed: standalone && laragon.detected() ? runtime.installed() : null,
    });
  }));

  // ---------- Cổng ----------
  r.post('/ports', wrap(async (req, res) => {
    const http = Number(req.body?.httpPort), db = Number(req.body?.mysqlPort);
    if (!validPort(http) || !validPort(db)) throw httpError(400, 'Cổng phải là số từ 1 đến 65535.');
    if (http === db || [config.port, config.sitesPort].includes(http) || [config.port, config.sitesPort].includes(db)) throw httpError(400, 'Các cổng không được trùng nhau hoặc trùng cổng của Sitebench.');
    const standalone = config.mode === 'standalone';
    const before = await services.status();
    const notes = [];
    if (standalone) {
      if (before.apache.running) await services.run('apache', 'stop');
      if (before.mysql.running && db !== Number(config.mysql.port)) await services.run('mysql', 'stop');
    }
    if (db !== Number(config.mysql.port)) {
      config.mysql.port = db;
      config.save();
      writeMysqlPortIni(config);
      laragon.restartFcgi();
      if (db !== 3306) notes.push(`WordPress (DB_HOST "localhost") tự kết nối cổng ${db}. Dự án Laravel: sửa DB_PORT=${db} trong .env.`);
      if (standalone) runtime.rewriteMyIni();
      else notes.push(`Đổi cổng MySQL trong Laragon (my.ini) thành ${db} cho khớp.`);
    }
    const oldHttp = Number(L.httpPort) || 80;
    await laragon.changeHttpPort(http);
    if (http !== oldHttp && http !== 80 && laragon.detected() && laragon.projects().some(p => p.wordpress)) {
      notes.push(`Site WordPress lưu địa chỉ không có cổng nên sẽ chuyển hướng về http://ten.test (cổng 80). Chỉ nên đổi cổng Apache khi cổng 80 bị chương trình khác chiếm; khi đó đổi địa chỉ site trong WordPress thành http://ten.test:${http}.`);
    }
    if (standalone) {
      runtime.regenerateApache();
      if (before.mysql.running) await services.run('mysql', 'start').catch(e => notes.push(e.message));
      if (before.apache.running) await services.run('apache', 'start').catch(e => notes.push(e.message));
    } else if (http !== before.apache.port) {
      notes.push(`Đổi cổng Apache trong Laragon (Menu → Apache → httpd.conf: Listen ${http}) cho khớp.`);
    }
    res.json({ ok: true, notes });
  }));

  r.post('/panel-port', wrap(async (req, res) => {
    const port = Number(req.body?.port);
    if (!validPort(port) || port < 1024) throw httpError(400, 'Cổng của Sitebench phải từ 1024 đến 65535.');
    if ([Number(L.httpPort), Number(config.mysql.port), config.sitesPort].includes(port)) throw httpError(400, 'Cổng này đang dùng cho máy chủ.');
    config.port = port;
    config.save();
    const tray = process.env.LOCALPANEL_TRAY === '1';
    res.json({ ok: true, url: `http://localhost:${port}/`, restarting: tray });
    if (tray) req.app.locals.restart?.();
  }));

  r.post('/restart', (req, res) => {
    const tray = process.env.LOCALPANEL_TRAY === '1';
    res.json({ ok: true, restarting: tray });
    if (tray) req.app.locals.restart?.();
  });

  // ---------- Chế độ máy chủ ----------
  r.post('/mode', wrap(async (req, res) => {
    const target = req.body?.mode;
    if (target === 'laragon') {
      const dir = path.resolve(String(req.body?.root || config.roots.laragon || ''));
      if (!isLaragonRoot(dir)) throw httpError(400, `Không thấy Laragon tại ${dir}.`);
      if (config.mode === 'standalone') {
        await services.run('all', 'stop').catch(() => {});
        config.roots.standalone = L.root;
      }
      config.mode = 'laragon';
      config.roots.laragon = fwd(dir);
      laragon.switchRoot(dir);
      return res.json({ ok: true, mode: 'laragon', note: 'Đã chuyển sang dùng Laragon. Bật Apache và MySQL trong mục Máy chủ & dự án hoặc trong Laragon.' });
    }
    if (target !== 'standalone') throw httpError(400, 'Chế độ không hợp lệ.');
    const dir = path.resolve(String(req.body?.root || config.roots.standalone || ''));
    // Đã có máy chủ độc lập: chuyển ngay. Chưa có: dựng mới (tác vụ nền)
    if (isStandaloneRoot(dir)) {
      if (config.mode !== 'standalone') {
        await services.run('all', 'stop').catch(() => {});
        config.roots.laragon = L.root;
      }
      config.mode = 'standalone';
      config.roots.standalone = fwd(dir);
      laragon.switchRoot(dir);
      runtime.regenerateApache();
      await laragon.refreshConfs().catch(() => {});
      laragon.restartFcgi();
      const message = await services.run('all', 'start').catch(e => `Chưa bật được: ${e.message}`);
      return res.json({ ok: true, mode: 'standalone', note: message });
    }
    if (!req.body?.root) throw httpError(400, 'Chọn thư mục để dựng máy chủ độc lập.');
    if (config.mode !== 'standalone') {
      await services.run('all', 'stop').catch(() => {});
      config.roots.laragon = L.root;
    }
    const job = jobs.start('Dựng máy chủ Sitebench', ctx => runtime.setupStandalone(ctx, req.body));
    res.json({ ok: true, job });
  }));

  return { router: r };
};
