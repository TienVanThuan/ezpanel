const express = require('express');
const fs = require('fs');
const path = require('path');
const { wrap, httpError, listen } = require('./util');

const SITE_NAME = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const DOMAIN = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

const starterPage = name => `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<style>
  body { font-family: "Segoe UI", system-ui, sans-serif; max-width: 40rem; margin: 15vh auto; padding: 0 1.5rem; color: #1c2733; line-height: 1.6; }
  code { background: #eef1f4; padding: .1em .35em; border-radius: 4px; }
</style>
</head>
<body>
  <h1>${name} đã sẵn sàng</h1>
  <p>Trang này nằm ở <code>sites/${name}/index.html</code>. Mở mục Quản lý file trong EzPanel để thay bằng nội dung của bạn.</p>
</body>
</html>
`;

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = (config) => {
  const dbFile = config.paths.sitesDb;
  let sites = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, 'utf8')) : [];
  const save = () => fs.writeFileSync(dbFile, JSON.stringify(sites, null, 2));
  const portServers = new Map(); // tên site -> [http.Server] (cổng riêng)
  const portErrors = new Map();

  const siteRoot = site => path.join(config.paths.sites, site.name);
  const siteStatic = site => express.static(siteRoot(site), { extensions: ['html', 'htm'], index: ['index.html', 'index.htm'] });

  const notFound = (res, msg) => res.status(404).send(
    `<!doctype html><meta charset="utf-8"><title>404</title><body style="font-family:system-ui;margin:15vh auto;max-width:36rem;padding:0 1.5rem"><h1>Không tìm thấy</h1><p>${esc(msg)}</p></body>`);

  // ----- Máy chủ chung, phân biệt website theo tên miền (virtual host) -----
  const hostApp = express();
  hostApp.disable('x-powered-by');
  hostApp.use((req, res, next) => {
    const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    const site = sites.find(s => s.domain === host);
    if (site && site.enabled) return siteStatic(site)(req, res, () => notFound(res, `Website ${site.name} không có ${req.path}.`));
    if (site) return res.status(503).send('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;margin:15vh auto;max-width:36rem"><h1>Website đang tạm dừng</h1><p>Bật lại trong EzPanel để truy cập.</p></body>');
    // Không khớp tên miền nào: hiển thị danh sách website
    const items = sites.filter(s => s.enabled)
      .map(s => `<li><a href="http://${esc(s.domain)}:${config.sitesPort}/">${esc(s.domain)}</a></li>`).join('');
    res.send(`<!doctype html><meta charset="utf-8"><title>Website local</title>
<body style="font-family:system-ui;margin:12vh auto;max-width:36rem;padding:0 1.5rem;line-height:1.6">
<h1>Website trên máy này</h1>${items ? `<ul>${items}</ul>` : '<p>Chưa có website nào đang chạy. Tạo website trong EzPanel.</p>'}</body>`);
  });

  // ----- Cổng riêng cho từng website (tùy chọn) -----
  async function startPort(site) {
    if (!site.port || !site.enabled || portServers.has(site.name)) return;
    const app = express();
    app.disable('x-powered-by');
    app.use(siteStatic(site));
    app.use((req, res) => notFound(res, `Website ${site.name} không có ${req.path}.`));
    try {
      portServers.set(site.name, await listen(app, site.port, config.host));
      portErrors.delete(site.name);
    } catch (err) {
      const msg = err.code === 'EADDRINUSE' ? `Cổng ${site.port} đang bị chương trình khác dùng.` : err.message;
      portErrors.set(site.name, msg);
      throw httpError(409, msg);
    }
  }
  function stopPort(name) {
    for (const srv of portServers.get(name) || []) srv.close();
    portServers.delete(name);
    portErrors.delete(name);
  }

  const view = s => ({
    ...s,
    root: siteRoot(s),
    url: `http://${s.domain}:${config.sitesPort}/`,
    portUrl: s.port ? `http://localhost:${s.port}/` : null,
    portRunning: s.port ? portServers.has(s.name) : null,
    portError: portErrors.get(s.name) || null,
    folder: path.relative(config.paths.files, siteRoot(s)).split(path.sep).join('/'),
  });

  // ----- API -----
  const router = express.Router();

  router.get('/', (req, res) => res.json({ sitesPort: config.sitesPort, sites: sites.map(view) }));

  router.post('/', wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim().toLowerCase();
    if (!SITE_NAME.test(name)) throw httpError(400, 'Tên website chỉ gồm chữ thường không dấu, số và dấu gạch ngang (tối đa 40 ký tự).');
    if (sites.some(s => s.name === name)) throw httpError(409, 'Đã có website trùng tên.');
    const domain = String(req.body?.domain || `${name}.localhost`).trim().toLowerCase();
    if (!DOMAIN.test(domain)) throw httpError(400, 'Tên miền không hợp lệ.');
    if (sites.some(s => s.domain === domain)) throw httpError(409, 'Tên miền này đã được dùng.');
    let port = null;
    if (req.body?.port) {
      port = Number(req.body.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw httpError(400, 'Cổng phải là số từ 1024 đến 65535.');
      if (port === config.port || port === config.sitesPort || sites.some(s => s.port === port)) {
        throw httpError(409, `Cổng ${port} đã được dùng trong EzPanel.`);
      }
    }
    const site = { name, domain, port, enabled: true, created: new Date().toISOString() };
    const root = siteRoot(site);
    fs.mkdirSync(root, { recursive: true });
    if (!fs.existsSync(path.join(root, 'index.html'))) fs.writeFileSync(path.join(root, 'index.html'), starterPage(name));
    sites.push(site);
    save();
    await startPort(site).catch(() => {}); // lỗi cổng được báo qua portError
    res.json({ ok: true, site: view(site) });
  }));

  router.post('/:name/toggle', wrap(async (req, res) => {
    const site = sites.find(s => s.name === req.params.name);
    if (!site) throw httpError(404, 'Không tìm thấy website.');
    site.enabled = !site.enabled;
    save();
    if (site.enabled) await startPort(site).catch(() => {});
    else stopPort(site.name);
    res.json({ ok: true, site: view(site) });
  }));

  router.delete('/:name', wrap(async (req, res) => {
    const site = sites.find(s => s.name === req.params.name);
    if (!site) throw httpError(404, 'Không tìm thấy website.');
    stopPort(site.name);
    sites = sites.filter(s => s !== site);
    save();
    if (req.query.files === '1') fs.rmSync(siteRoot(site), { recursive: true, force: true });
    res.json({ ok: true });
  }));

  return {
    router,
    summary: () => ({ total: sites.length, running: sites.filter(s => s.enabled).length }),
    async start() {
      await listen(hostApp, config.sitesPort, config.host);
      for (const s of sites) await startPort(s).catch(e => console.warn(`  [${s.name}] ${e.message}`));
    },
  };
};
