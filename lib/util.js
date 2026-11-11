const http = require('http');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Bọc route async để lỗi được chuyển tới error handler của Express
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Lắng nghe trên loopback cả IPv4 và IPv6 (trình duyệt có thể dùng ::1 cho "localhost").
// Nếu host không phải loopback (vd 0.0.0.0) thì chỉ lắng nghe đúng host đó.
function listen(app, port, host) {
  const hosts = host === '127.0.0.1' || host === 'localhost' ? ['127.0.0.1', '::1'] : [host];
  const servers = [];
  return Promise.all(hosts.map((h, i) => new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.requestTimeout = 0; // thao tác dài như sao lưu, cài WordPress không bị ngắt giữa chừng
    srv.once('error', err => {
      // ::1 có thể không khả dụng nếu máy tắt IPv6 – bỏ qua
      if (i > 0 && (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT')) return resolve();
      reject(err);
    });
    srv.listen(port, h, () => { servers.push(srv); resolve(); });
  }))).then(() => servers, err => {
    servers.forEach(s => s.close()); // đóng các cổng đã mở dở
    throw err;
  });
}

module.exports = { httpError, wrap, listen };

// ---------- Tải dữ liệu qua HTTP(S), tự theo chuyển hướng ----------
const httpsMod = require('https');
const fs = require('fs');
function get(url, depth = 0, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? httpsMod : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EzPanel', ...headers }, timeout: 30000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && depth < 8) {
        res.resume();
        return get(new URL(res.headers.location, url).href, depth + 1, headers).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} khi tải ${url}`)); }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error(`Hết thời gian chờ khi tải ${url}`)));
    req.on('error', reject);
  });
}
async function fetchText(url, headers) {
  const res = await get(url, 0, headers);
  let body = '';
  res.setEncoding('utf8');
  for await (const chunk of res) body += chunk;
  return body;
}
// Tải tệp: onProgress(đã tải, tổng). Phát hiện kết nối đứng yên (không có dữ liệu trong idleMs) và tự thử lại.
async function downloadOnce(url, dest, { headers, onProgress, idleMs = 45000 } = {}) {
  const { pipeline } = require('stream/promises');
  const res = await get(url, 0, headers);
  const total = Number(res.headers['content-length']) || 0;
  let got = 0, lastData = Date.now();
  res.on('data', d => { got += d.length; lastData = Date.now(); onProgress?.(got, total); });
  const watchdog = setInterval(() => {
    if (Date.now() - lastData > idleMs) res.destroy(new Error(`kết nối đứng yên quá ${Math.round(idleMs / 1000)} giây (đã tải ${Math.round(got / 1048576)} MB)`));
  }, 5000);
  const tmp = `${dest}.part`;
  try {
    await pipeline(res, fs.createWriteStream(tmp)); // báo lỗi cả khi kết nối bị đóng giữa chừng
  } finally {
    clearInterval(watchdog);
  }
  if (total && got < total) throw new Error(`tải thiếu (${got}/${total} byte)`);
  fs.renameSync(tmp, dest);
}
async function download(url, dest, opts = {}) {
  const attempts = opts.attempts || 3;
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try { return await downloadOnce(url, dest, opts); } catch (e) {
      if (/^aborted$|ECONNRESET|socket hang up|premature close/i.test(e.message || e.code || '')) e = new Error('kết nối bị ngắt giữa chừng');
      lastErr = e;
      try { fs.rmSync(`${dest}.part`, { force: true }); } catch { /* bỏ qua */ }
      if (/HTTP 4\d\d/.test(e.message) || i === attempts) break;
      opts.onRetry?.(i, e);
      await new Promise(r => setTimeout(r, 3000 * i));
    }
  }
  throw lastErr;
}

// Giải nén zip.
// - preferTar (gói phần mềm, tên tệp không dấu): trên Windows dùng tar.exe của hệ thống, nhanh và ổn định.
// - còn lại (sao lưu, nhập site, template…): dùng yauzl 3, giữ đúng tên tệp tiếng Việt / tiếng Nhật,
//   chặn đường dẫn thoát ra ngoài thư mục đích, và báo lỗi nếu đứng yên quá lâu (không bao giờ treo im lặng).
async function unzip(zip, dir, { log, preferTar = false, idleMs = 60000, timeoutMs = 30 * 60 * 1000 } = {}) {
  const path = require('path');
  const { pipeline } = require('stream/promises');
  zip = path.resolve(zip);
  dir = path.resolve(dir);
  fs.mkdirSync(dir, { recursive: true });
  const tar = preferTar && process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : null;
  if (tar && fs.existsSync(tar)) {
    await new Promise((resolve, reject) => {
      require('child_process').execFile(tar, ['-xf', zip, '-C', dir], { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err) return resolve();
        const msg = String(stderr || err.message).trim().split(/\r?\n/).filter(Boolean).slice(-1)[0];
        reject(new Error(err.killed ? 'giải nén quá lâu' : `giải nén thất bại: ${msg}`));
      });
    });
    return;
  }
  const yauzl = require('yauzl');
  const zipfile = await new Promise((resolve, reject) => yauzl.open(zip, { lazyEntries: true, autoClose: true }, (e, z) => (e ? reject(e) : resolve(z))));
  let n = 0, last = Date.now(), done = false;
  const started = Date.now();
  await new Promise((resolve, reject) => {
    const fail = e => { if (done) return; done = true; clearInterval(watch); try { zipfile.close(); } catch { /* đã đóng */ } reject(e); };
    const watch = setInterval(() => {
      if (Date.now() - last > idleMs) fail(new Error(`giải nén đứng yên quá ${Math.round(idleMs / 1000)} giây (đã xong ${n} tệp)`));
      else if (Date.now() - started > timeoutMs) fail(new Error(`giải nén quá lâu (đã xong ${n} tệp)`));
    }, 5000);
    zipfile.on('error', fail);
    zipfile.on('end', () => { if (!done) { done = true; clearInterval(watch); resolve(); } });
    zipfile.on('entry', async entry => {
      try {
        const name = entry.fileName.replace(/\\/g, '/');
        const dest = path.resolve(dir, name);
        if (dest !== dir && !dest.startsWith(dir + path.sep)) throw new Error(`đường dẫn không hợp lệ trong tệp zip: ${name}`);
        if (/\/$/.test(name)) fs.mkdirSync(dest, { recursive: true });
        else {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          const rs = await new Promise((res, rej) => zipfile.openReadStream(entry, (e, st) => (e ? rej(e) : res(st))));
          rs.on('data', () => { last = Date.now(); });
          await pipeline(rs, fs.createWriteStream(dest));
          if (entry.getLastModDate) { const t = entry.getLastModDate(); try { fs.utimesSync(dest, t, t); } catch { /* bỏ qua */ } }
        }
        n++;
        last = Date.now();
        if (n % 1000 === 0) log?.(`  đã giải nén ${n} tệp`);
        zipfile.readEntry();
      } catch (e) { fail(e); }
    });
    zipfile.readEntry();
  });
}

module.exports.unzip = unzip;
module.exports.fetchText = fetchText;
module.exports.download = download;
