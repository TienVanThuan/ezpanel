// Cấu hình PHP cho từng phiên bản trong Laragon: các giá trị php.ini hay dùng, mẫu "Tối ưu cho WooCommerce",
// bật/tắt extension và Xdebug (tự tải đúng bản Xdebug cho phiên bản PHP, kiểu Thread Safe và trình biên dịch).

const express = require('express');
const fs = require('fs');
const path = require('path');
const { wrap, httpError, fetchText, download } = require('./util');

const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const isWin = process.platform === 'win32';
const fwd = p => p.split(path.sep).join('/');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Các giá trị hiển thị trên giao diện
const SETTINGS = [
  { key: 'memory_limit', label: 'Bộ nhớ tối đa cho mỗi request', hint: 'WooCommerce nên từ 256M, tốt nhất 512M' },
  { key: 'max_execution_time', label: 'Thời gian chạy tối đa (giây)', hint: 'Nhập/xuất sản phẩm, cập nhật cần thời gian dài' },
  { key: 'max_input_time', label: 'Thời gian nhận dữ liệu tối đa (giây)' },
  { key: 'max_input_vars', label: 'Số trường dữ liệu tối đa (max_input_vars)', hint: 'Mặc định 1000: menu lớn, sản phẩm nhiều biến thể sẽ bị mất dữ liệu khi lưu' },
  { key: 'upload_max_filesize', label: 'Dung lượng tải lên tối đa', hint: 'Tải giao diện/plugin dạng zip, ảnh lớn' },
  { key: 'post_max_size', label: 'Dung lượng gửi form tối đa', hint: 'Nên bằng hoặc lớn hơn dung lượng tải lên' },
  { key: 'display_errors', label: 'Hiện lỗi PHP trên trang', type: 'onoff' },
  { key: 'date.timezone', label: 'Múi giờ' },
  { key: 'opcache.enable', label: 'OPcache (tăng tốc PHP)', type: 'onoff' },
  { key: 'opcache.revalidate_freq', label: 'OPcache kiểm tra code mới sau (giây)', hint: '0 = nhận ngay khi sửa code' },
  { key: 'realpath_cache_size', label: 'Bộ đệm đường dẫn (realpath_cache_size)', hint: 'Tăng lên 4096K giúp PHP trên Windows nhanh hơn rõ rệt' },
];

const PRESET_WOO = {
  memory_limit: '512M', max_execution_time: '300', max_input_time: '300', max_input_vars: '10000',
  upload_max_filesize: '256M', post_max_size: '256M', 'date.timezone': 'Asia/Ho_Chi_Minh',
  realpath_cache_size: '4096K', realpath_cache_ttl: '600',
  'opcache.enable': '1', 'opcache.enable_cli': '0', 'opcache.validate_timestamps': '1', 'opcache.revalidate_freq': '0',
  'opcache.memory_consumption': '256', 'opcache.max_accelerated_files': '20000',
};
const PRESET_EXTENSIONS = ['curl', 'exif', 'fileinfo', 'gd', 'gd2', 'intl', 'mbstring', 'mysqli', 'openssl', 'pdo_mysql', 'soap', 'sodium', 'zip', 'bcmath'];

// ---------- Đọc / ghi php.ini ----------
function getSetting(text, key) {
  let val = null;
  for (const m of text.matchAll(new RegExp(`^[ \\t]*${esc(key)}[ \\t]*=[ \\t]*(.*)$`, 'gmi'))) {
    val = m[1].replace(/\s;.*$/, '').trim().replace(/^"(.*)"$/, '$1');
  }
  return val;
}
function setSetting(text, key, value) {
  const line = `${key} = ${/[\s;=]/.test(value) ? `"${value}"` : value}`;
  const active = new RegExp(`^[ \\t]*${esc(key)}[ \\t]*=.*$`, 'gmi');
  if (active.test(text)) {
    let first = true;
    // Giữ một dòng, bỏ các dòng trùng phía sau
    return text.replace(active, () => (first ? ((first = false), line) : `;${key} (EzPanel: dòng trùng đã tắt)`));
  }
  const commented = new RegExp(`^[ \\t]*;[ \\t]*${esc(key)}[ \\t]*=.*$`, 'mi');
  if (commented.test(text)) return text.replace(commented, line);
  return `${text.replace(/\s*$/, '')}\n${line}\n`;
}

const XDEBUG_BEGIN = '; >>> LocalPanel Xdebug';
const XDEBUG_END = '; <<< LocalPanel Xdebug';
const stripXdebug = text => text.replace(new RegExp(`\\n?${esc(XDEBUG_BEGIN)}[\\s\\S]*?${esc(XDEBUG_END)}\\n?`, 'g'), '\n');

module.exports = (config, { laragon }) => {
  const r = express.Router();

  const check = folder => {
    if (!laragon.detected() || !laragon.phpVersions().includes(folder)) throw httpError(404, 'Không tìm thấy phiên bản PHP này trong Laragon.');
    laragon.ensurePhpIni(folder);
    return folder;
  };
  const iniPath = folder => path.join(laragon.phpDir(folder), 'php.ini');
  const extDir = folder => path.join(laragon.phpDir(folder), 'ext');
  const read = folder => fs.readFileSync(iniPath(folder), 'utf8');
  function write(folder, text) {
    const file = iniPath(folder);
    const backup = `${file}.localpanel-backup`;
    if (!exists(backup)) fs.copyFileSync(file, backup); // sao lưu một lần trước khi sửa lần đầu
    fs.writeFileSync(file, text);
  }
  const mm = folder => laragon.versionOf(folder).split('.').slice(0, 2).join('.');

  // PHP đọc lại cấu hình: khởi động lại Apache nếu đây là PHP mặc định, khởi động lại php-cgi nếu dự án dùng
  async function reload(folder) {
    const out = {};
    if (laragon.usedVersions().includes(folder)) { laragon.restartFcgi(); out.fcgi = true; }
    if (folder === laragon.defaultPhp()) Object.assign(out, await laragon.afterApacheChange());
    return out;
  }

  // ---------- Extension ----------
  function extensions(folder, text) {
    const dir = extDir(folder);
    if (!exists(dir)) return [];
    return fs.readdirSync(dir).map(f => (/^php_([a-z0-9_]+)\.dll$/i.exec(f) || [])[1]).filter(Boolean)
      .filter(n => !['opcache', 'xdebug'].includes(n.toLowerCase()))
      .map(name => ({ name, enabled: new RegExp(`^[ \\t]*extension[ \\t]*=[ \\t]*"?(php_)?${esc(name)}(\\.dll)?"?[ \\t]*(;.*)?$`, 'mi').test(text) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  function setExtension(text, name, on) {
    const activeRe = new RegExp(`^[ \\t]*extension[ \\t]*=[ \\t]*"?(php_)?${esc(name)}(\\.dll)?"?[ \\t]*(;.*)?$`, 'gmi');
    const commentedRe = new RegExp(`^[ \\t]*;[ \\t]*extension[ \\t]*=[ \\t]*"?(php_)?${esc(name)}(\\.dll)?"?[ \\t]*(;.*)?$`, 'mi');
    if (on) {
      if (activeRe.test(text)) return text;
      if (commentedRe.test(text)) return text.replace(commentedRe, l => l.replace(/^[ \t]*;[ \t]*/, ''));
      return `${text.replace(/\s*$/, '')}\nextension=${name}\n`;
    }
    return text.replace(activeRe, l => `;${l.trim()}`);
  }
  // OPcache là zend_extension; PHP 8.5 trở đi có sẵn trong PHP
  function enableOpcache(folder, text) {
    const [maj, min] = laragon.versionOf(folder).split('.').map(Number);
    if (maj > 8 || (maj === 8 && min >= 5)) return text;
    if (/^[ \t]*zend_extension[ \t]*=.*opcache/mi.test(text)) return text;
    const commented = /^[ \t]*;[ \t]*zend_extension[ \t]*=[ \t]*"?(php_)?opcache(\.dll)?"?[ \t]*$/mi;
    if (commented.test(text)) return text.replace(commented, l => l.replace(/^[ \t]*;[ \t]*/, ''));
    if (isWin && !exists(path.join(extDir(folder), 'php_opcache.dll'))) return text;
    return `${text.replace(/\s*$/, '')}\nzend_extension=opcache\n`;
  }

  // ---------- Xdebug ----------
  let xdCache = null;
  async function xdebugFiles() {
    if (xdCache && Date.now() - xdCache.at < 24 * 3600e3) return xdCache.files;
    let html;
    try { html = await fetchText(config.xdebugUrl || 'https://xdebug.org/download/historical'); } catch (e) {
      throw httpError(502, `Không tải được danh sách Xdebug (${e.message}). Kiểm tra kết nối Internet.`);
    }
    const files = new Set();
    for (const m of html.matchAll(/php_xdebug-[A-Za-z0-9.\-_]+?\.dll/g)) files.add(m[0]);
    xdCache = { at: Date.now(), files: [...files] };
    return xdCache.files;
  }
  // Tên tệp: 3.4.1+  php_xdebug-3.5.3-8.2-ts-vs16-x86_64.dll / ...-nts-vs16-...
  //          3.0–3.4.0 php_xdebug-3.1.6-7.4-vc15-x86_64.dll (Thread Safe) / ...-vc15-nts-x86_64.dll
  function pickXdebug(files, folder) {
    const want = { mm: mm(folder), cc: ((/(vc\d+|vs\d+)/i.exec(folder) || [])[1] || '').toLowerCase(), ts: !/nts/i.test(folder) };
    const ok = [];
    for (const f of files) {
      const m = /^php_xdebug-(\d+)\.(\d+)\.(\d+)-(\d+\.\d+)-(?:(ts|nts)-)?(v[cs]\d+)(-nts)?-x86_64\.dll$/i.exec(f);
      if (!m || +m[1] < 3) continue; // bỏ bản alpha/beta/RC, bản 32-bit và Xdebug 2 (cấu hình khác hẳn)
      const ts = m[5] ? m[5].toLowerCase() === 'ts' : !m[7];
      if (m[4] !== want.mm || ts !== want.ts || (want.cc && m[6].toLowerCase() !== want.cc)) continue;
      ok.push({ file: f, version: `${m[1]}.${m[2]}.${m[3]}`, v: [+m[1], +m[2], +m[3]] });
    }
    ok.sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
    return ok[0] || null;
  }
  const xdebugDll = folder => path.join(extDir(folder), 'php_xdebug.dll');
  function xdebugState(text) {
    const ours = text.includes(XDEBUG_BEGIN);
    const other = /^[ \t]*zend_extension[ \t]*=.*xdebug/mi.test(stripXdebug(text));
    const mode = ours ? (/xdebug\.mode\s*=\s*([^\r\n]+)/.exec(text.slice(text.indexOf(XDEBUG_BEGIN))) || [])[1]?.trim() : null;
    return { enabled: ours || other, managed: ours, other, mode };
  }
  function xdebugBlock(folder, mode) {
    const out = path.join(config.paths.logs, 'xdebug');
    return [
      XDEBUG_BEGIN,
      `zend_extension="${fwd(xdebugDll(folder))}"`,
      `xdebug.mode=${mode}`,
      'xdebug.start_with_request=trigger',
      'xdebug.client_host=127.0.0.1',
      'xdebug.client_port=9003',
      `xdebug.output_dir="${fwd(out)}"`,
      XDEBUG_END,
    ].join('\n');
  }

  // ---------- API ----------
  r.get('/:folder', wrap(async (req, res) => {
    const folder = check(req.params.folder);
    const text = read(folder);
    res.json({
      folder, version: laragon.versionOf(folder),
      isDefault: folder === laragon.defaultPhp(),
      usedBy: laragon.projects().filter(p => p.php === folder).map(p => p.name),
      settings: SETTINGS.map(s => ({ ...s, value: getSetting(text, s.key) })),
      extensions: extensions(folder, text),
      xdebug: { ...xdebugState(text), installed: exists(xdebugDll(folder)) },
      hasBackup: exists(`${iniPath(folder)}.localpanel-backup`),
      iniPath: iniPath(folder),
    });
  }));

  r.post('/:folder/settings', wrap(async (req, res) => {
    const folder = check(req.params.folder);
    const values = req.body?.values || {};
    let text = read(folder);
    for (const [k, v] of Object.entries(values)) {
      if (!SETTINGS.some(s => s.key === k)) continue;
      const val = String(v).trim();
      if (!/^[A-Za-z0-9_\-./+: ]{0,100}$/.test(val)) throw httpError(400, `Giá trị không hợp lệ cho ${k}.`);
      if (val) text = setSetting(text, k, val);
    }
    if (values['opcache.enable'] === '1' || values['opcache.enable'] === 'On') text = enableOpcache(folder, text);
    write(folder, text);
    res.json({ ok: true, ...(await reload(folder)) });
  }));

  r.post('/:folder/preset', wrap(async (req, res) => {
    const folder = check(req.params.folder);
    let text = read(folder);
    for (const [k, v] of Object.entries(PRESET_WOO)) text = setSetting(text, k, v);
    text = enableOpcache(folder, text);
    const available = extensions(folder, text).map(e => e.name.toLowerCase());
    for (const e of PRESET_EXTENSIONS) if (!isWin || available.includes(e)) text = setExtension(text, e, true);
    write(folder, text);
    res.json({ ok: true, ...(await reload(folder)) });
  }));

  r.post('/:folder/extension', wrap(async (req, res) => {
    const folder = check(req.params.folder);
    const name = String(req.body?.name || '');
    if (!extensions(folder, read(folder)).some(e => e.name === name)) throw httpError(400, 'Không có extension này trong thư mục ext.');
    write(folder, setExtension(read(folder), name, !!req.body?.on));
    res.json({ ok: true, ...(await reload(folder)) });
  }));

  r.post('/:folder/restore', wrap(async (req, res) => {
    const folder = check(req.params.folder);
    const backup = `${iniPath(folder)}.localpanel-backup`;
    if (!exists(backup)) throw httpError(404, 'Chưa có bản sao lưu php.ini.');
    fs.copyFileSync(backup, iniPath(folder));
    res.json({ ok: true, ...(await reload(folder)) });
  }));

  r.post('/:folder/xdebug', wrap(async (req, res) => {
    const folder = check(req.params.folder);
    const on = !!req.body?.on;
    const mode = ['debug', 'debug,develop', 'profile', 'develop'].includes(req.body?.mode) ? req.body.mode : 'debug';
    let text = stripXdebug(read(folder));
    let installed = null;
    if (on) {
      if (xdebugState(text).other) throw httpError(409, 'php.ini đã có cấu hình Xdebug khác (không do EzPanel thêm). Hãy xóa dòng zend_extension=...xdebug trong php.ini trước.');
      if (!exists(xdebugDll(folder)) || req.body?.update) {
        const pick = pickXdebug(await xdebugFiles(), folder);
        if (!pick) throw httpError(404, `Xdebug chưa có bản cho PHP ${mm(folder)} (${folder}).`);
        fs.mkdirSync(extDir(folder), { recursive: true });
        await download(`https://xdebug.org/files/${pick.file}`, xdebugDll(folder))
          .catch(e => { throw httpError(502, `Tải Xdebug thất bại: ${e.message}`); });
        installed = pick.version;
      }
      fs.mkdirSync(path.join(config.paths.logs, 'xdebug'), { recursive: true });
      text = `${text.replace(/\s*$/, '')}\n\n${xdebugBlock(folder, mode)}\n`;
    }
    write(folder, text);
    res.json({ ok: true, installed, ...(await reload(folder)) });
  }));

  return { router: r, pickXdebug, getSetting, setSetting, setExtension };
};
