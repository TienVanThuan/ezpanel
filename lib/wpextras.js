// Tiện ích cho site WordPress / WooCommerce ở local:
//  - An toàn cho shop: tắt cổng thanh toán trực tuyến (có lưu để khôi phục), tạm dừng tác vụ ngầm
//    (Action Scheduler, WP-Cron) và webhook, ẩn danh dữ liệu khách hàng.
//  - Ảnh lấy từ production: ảnh nào không có ở local thì chuyển hướng về site thật.
//  - Xem qua Wi-Fi: mu-plugin đổi địa chỉ site khi truy cập bằng IP của máy.

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { wrap, httpError } = require('./util');

const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const OFFLINE_GATEWAYS = ['bacs', 'cheque', 'cod']; // không trừ tiền thật

const SAFETY_PLUGIN = `<?php
/**
 * Plugin Name: Sitebench - An toàn cho shop ở local
 * Description: Tạm dừng tác vụ ngầm (Action Scheduler), webhook và tác vụ định kỳ để bản local không gửi dữ liệu, gia hạn hay trừ tiền thật. Do Sitebench cài; tắt chế độ an toàn trong Sitebench để gỡ.
 */
add_filter('action_scheduler_allow_async_request_runner', '__return_false');
add_filter('action_scheduler_queue_runner_concurrent_batches', function () { return 0; });
add_filter('woocommerce_webhook_should_deliver', '__return_false');
add_action('admin_notices', function () {
    echo '<div class="notice notice-warning"><p><strong>Sitebench:</strong> Chế độ an toàn cho shop đang bật: cổng thanh toán trực tuyến đã tắt, tác vụ ngầm, webhook và WP-Cron tạm dừng.</p></div>';
});
`;

// Script chạy bằng WP-CLI (không nạp plugin): tắt hoặc khôi phục cổng thanh toán trực tuyến
const GATEWAY_SCRIPT = `<?php
$mode = getenv('LP_MODE');
$offline = array('bacs', 'cheque', 'cod');
$known = '/^(stripe|ppcp|paypal|woocommerce_payments|square|braintree|authorize|mollie|klarna|amazon|razorpay|paystack|vnpay|momo|onepay|alepay|zalopay|payos|sepay|casso|vietqr|napas|2c2p|paymentwall|adyen|checkout|worldpay|eway|payfast|yith)/i';
$secret = '/(secret|api_?key|private|publishable|token|merchant|client_id|password|signature|hash_?key|access_?key)/i';
$backup = get_option('localpanel_gateway_backup', array());
$changed = array();
if ($mode === 'disable') {
    $order = get_option('woocommerce_gateway_order', array());
    $ids = is_array($order) ? array_keys($order) : array();
    global $wpdb;
    $rows = $wpdb->get_col("SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE 'woocommerce\\\\_%\\\\_settings'");
    foreach ($rows as $opt) {
        $id = substr($opt, 12, -9);
        if (in_array($id, $offline, true)) continue;
        $val = get_option($opt);
        if (!is_array($val) || !isset($val['enabled']) || $val['enabled'] !== 'yes') continue;
        $looks = in_array($id, $ids, true) || preg_match($known, $id);
        if (!$looks) { foreach (array_keys($val) as $k) { if (preg_match($secret, $k)) { $looks = true; break; } } }
        if (!$looks) continue;
        if (!isset($backup[$opt])) $backup[$opt] = $val['enabled'];
        $val['enabled'] = 'no';
        update_option($opt, $val);
        $changed[] = $id;
    }
    update_option('localpanel_gateway_backup', $backup, false);
} elseif ($mode === 'restore') {
    foreach ($backup as $opt => $enabled) {
        $val = get_option($opt);
        if (!is_array($val)) continue;
        $val['enabled'] = $enabled;
        update_option($opt, $val);
        $changed[] = substr($opt, 12, -9);
    }
    delete_option('localpanel_gateway_backup');
} else {
    foreach ($backup as $opt => $enabled) $changed[] = substr($opt, 12, -9);
}
echo json_encode(array('changed' => $changed));
`;

const lanPlugin = (port, domain) => `<?php
/**
 * Plugin Name: Sitebench - Xem trên điện thoại qua Wi-Fi
 * Description: Khi mở site bằng địa chỉ IP của máy (cổng ${port}), đổi địa chỉ site cho khớp để xem được trên điện thoại. Do Sitebench cài.
 */
if (isset($_SERVER['SERVER_PORT'], $_SERVER['HTTP_HOST']) && (int) $_SERVER['SERVER_PORT'] === ${port}) {
    $lp_origin = 'http://' . $_SERVER['HTTP_HOST'];
    $lp_url = function () use ($lp_origin) { return $lp_origin; };
    add_filter('option_home', $lp_url, 99);
    add_filter('option_siteurl', $lp_url, 99);
    remove_action('template_redirect', 'redirect_canonical');
    $lp_from = array('https://${domain}', 'http://${domain}', 'https:\\\\/\\\\/${domain}', 'http:\\\\/\\\\/${domain}');
    $lp_esc = str_replace('/', '\\\\/', $lp_origin);
    $lp_to = array($lp_origin, $lp_origin, $lp_esc, $lp_esc);
    // Địa chỉ không ghi giao thức (//ten.test) đổi sau cùng
    $lp_from[] = '//${domain}';
    $lp_to[] = '//' . $_SERVER['HTTP_HOST'];
    $lp_from[] = '\\/\\/${domain}';
    $lp_to[] = '\\/\\/' . $_SERVER['HTTP_HOST'];
    ob_start(function ($html) use ($lp_from, $lp_to) { return str_replace($lp_from, $lp_to, $html); });
}
`;

const UPLOADS_BEGIN = '# BEGIN LocalPanel: ảnh từ production';
const UPLOADS_END = '# END LocalPanel';

module.exports = (config, { laragon, wpTools }) => {
  const W = wpTools;
  const r = express.Router();
  const dir = name => laragon.projectDir(name);
  const muDir = name => path.join(dir(name), 'wp-content', 'mu-plugins');
  const isWoo = name => exists(path.join(dir(name), 'wp-content', 'plugins', 'woocommerce', 'woocommerce.php'));
  const checkWp = name => {
    laragon.checkProject(name);
    if (!W.isWp(name) || !W.readConfig(name)) throw httpError(404, `"${name}" không phải site WordPress đã cài đặt.`);
    return name;
  };

  // ---------- Thông tin lưu kèm site (địa chỉ production…) ----------
  const metaFile = () => {
    const d = config.paths.laragonData();
    return d ? path.join(d, 'sites-meta.json') : path.join(config.paths.tools, 'sites-meta.json');
  };
  const readMeta = () => { try { return JSON.parse(fs.readFileSync(metaFile(), 'utf8')); } catch { return {}; } };
  function setMeta(name, patch) {
    const all = readMeta();
    all[name] = { ...(all[name] || {}), ...patch };
    fs.mkdirSync(path.dirname(metaFile()), { recursive: true });
    fs.writeFileSync(metaFile(), JSON.stringify(all, null, 2));
  }

  async function db(name) {
    const cfg = W.readConfig(name);
    const dbName = W.readDefine(cfg, 'DB_NAME');
    const prefix = (/\$table_prefix\s*=\s*['"]([^'"]+)['"]/.exec(cfg) || [])[1] || 'wp_';
    if (!/^[A-Za-z0-9_]+$/.test(prefix)) throw httpError(400, 'Tiền tố bảng của site không hợp lệ.');
    const conn = await mysql.createConnection({ ...config.mysql, database: dbName, charset: 'utf8mb4', multipleStatements: false })
      .catch(e => { throw httpError(502, `Không kết nối được MySQL: ${e.message}`); });
    return { conn, prefix };
  }

  // ---------- An toàn cho shop ----------
  async function runGateways(name, mode) {
    const script = path.join(config.paths.tools, `gw-${crypto.randomBytes(4).toString('hex')}.php`);
    fs.mkdirSync(config.paths.tools, { recursive: true });
    fs.writeFileSync(script, GATEWAY_SCRIPT);
    try {
      process.env.LP_MODE = mode; // WP-CLI kế thừa biến môi trường
      const out = await W.wp(name, ['eval-file', script], { safe: true });
      return JSON.parse(out.slice(out.indexOf('{'))).changed || [];
    } finally {
      delete process.env.LP_MODE;
      fs.rmSync(script, { force: true });
    }
  }
  async function shopStatus(name) {
    const cfg = W.readConfig(name) || '';
    return {
      woocommerce: isWoo(name),
      safety: exists(path.join(muDir(name), 'localpanel-shop-safety.php')),
      cronDisabled: W.readDefine(cfg, 'DISABLE_WP_CRON') === 'true',
      gatewaysDisabled: isWoo(name) ? await runGateways(name, 'status').catch(() => []) : [],
      anonymized: readMeta()[name]?.anonymized || null,
    };
  }
  async function enableSafety(name) {
    fs.mkdirSync(muDir(name), { recursive: true });
    fs.writeFileSync(path.join(muDir(name), 'localpanel-shop-safety.php'), SAFETY_PLUGIN);
    fs.writeFileSync(W.configPath(name), W.setDefine(W.readConfig(name), 'DISABLE_WP_CRON', 'true'));
    const gateways = isWoo(name) ? await runGateways(name, 'disable') : [];
    return { gateways };
  }
  async function disableSafety(name, restoreGateways) {
    fs.rmSync(path.join(muDir(name), 'localpanel-shop-safety.php'), { force: true });
    fs.writeFileSync(W.configPath(name), W.setDefine(W.readConfig(name), 'DISABLE_WP_CRON', 'false'));
    const gateways = restoreGateways && isWoo(name) ? await runGateways(name, 'restore') : [];
    return { gateways };
  }

  // Ẩn danh khách hàng: đổi email, số điện thoại, địa chỉ, tên của khách và đơn hàng (không đụng tài khoản quản trị)
  async function anonymize(name) {
    const { conn, prefix: p } = await db(name);
    const done = {};
    const run = async (label, sql) => {
      try { const [res] = await conn.query(sql); done[label] = (done[label] || 0) + (res.affectedRows || 0); } catch (e) {
        if (!/doesn't exist|Unknown column/i.test(e.message)) throw e; // bảng không có (chưa dùng HPOS…) thì bỏ qua
      }
    };
    try {
      // Khách = người dùng có vai trò customer/subscriber và không có quyền quản trị
      const customers = `SELECT user_id FROM ${p}usermeta WHERE meta_key = '${p}capabilities'
        AND (meta_value LIKE '%"customer"%' OR meta_value LIKE '%"subscriber"%')
        AND meta_value NOT LIKE '%"administrator"%' AND meta_value NOT LIKE '%"shop_manager"%' AND meta_value NOT LIKE '%"editor"%'`;
      await run('Tài khoản khách', `UPDATE ${p}users SET user_email = CONCAT('khach', ID, '@example.test'), display_name = CONCAT('Khách ', ID)
        WHERE ID IN (SELECT user_id FROM (${customers}) c)`);
      await run('Thông tin khách', `UPDATE ${p}usermeta SET meta_value = CASE
          WHEN meta_key LIKE '%email' THEN CONCAT('khach', user_id, '@example.test')
          WHEN meta_key LIKE '%phone' THEN '0900000000'
          WHEN meta_key LIKE '%first_name' THEN 'Khách'
          WHEN meta_key LIKE '%last_name' THEN CAST(user_id AS CHAR)
          ELSE 'Địa chỉ đã ẩn' END
        WHERE meta_key IN ('billing_email','billing_phone','billing_first_name','billing_last_name','billing_address_1','billing_address_2',
          'shipping_phone','shipping_first_name','shipping_last_name','shipping_address_1','shipping_address_2','first_name','last_name')
          AND user_id IN (SELECT user_id FROM (${customers}) c)`);
      // Đơn hàng kiểu cũ (lưu trong posts/postmeta)
      await run('Đơn hàng', `UPDATE ${p}postmeta pm JOIN ${p}posts po ON po.ID = pm.post_id
        AND po.post_type IN ('shop_order','shop_order_refund','shop_subscription','shop_order_placehold')
        SET pm.meta_value = CASE
          WHEN pm.meta_key LIKE '%email' THEN CONCAT('donhang', pm.post_id, '@example.test')
          WHEN pm.meta_key LIKE '%phone' THEN '0900000000'
          WHEN pm.meta_key LIKE '%first_name' THEN 'Khách'
          WHEN pm.meta_key LIKE '%last_name' THEN CAST(pm.post_id AS CHAR)
          WHEN pm.meta_key = '_customer_ip_address' THEN '127.0.0.1'
          ELSE 'Địa chỉ đã ẩn' END
        WHERE pm.meta_key IN ('_billing_email','_billing_phone','_billing_first_name','_billing_last_name','_billing_address_1','_billing_address_2',
          '_shipping_phone','_shipping_first_name','_shipping_last_name','_shipping_address_1','_shipping_address_2','_customer_ip_address',
          '_billing_address_index','_shipping_address_index')`);
      // Đơn hàng kiểu mới (HPOS)
      await run('Đơn hàng', `UPDATE ${p}wc_orders SET billing_email = CONCAT('donhang', id, '@example.test'), ip_address = '127.0.0.1'`);
      await run('Đơn hàng', `UPDATE ${p}wc_order_addresses SET email = CONCAT('donhang', order_id, '@example.test'), phone = '0900000000',
        first_name = 'Khách', last_name = CAST(order_id AS CHAR), address_1 = 'Địa chỉ đã ẩn', address_2 = '', company = ''`);
      await run('Thống kê khách', `UPDATE ${p}wc_customer_lookup SET email = CONCAT('khach', customer_id, '@example.test'), first_name = 'Khách', last_name = CAST(customer_id AS CHAR)`);
      // Email trong bình luận / đánh giá sản phẩm (trừ người quản trị đã đăng nhập khi bình luận)
      await run('Bình luận', `UPDATE ${p}comments SET comment_author_email = CONCAT('binhluan', comment_ID, '@example.test'), comment_author_IP = '127.0.0.1'
        WHERE user_id = 0 OR user_id IN (SELECT user_id FROM (${customers}) c)`);
    } finally {
      conn.end().catch(() => {});
    }
    setMeta(name, { anonymized: new Date().toISOString() });
    return done;
  }

  // ---------- Ảnh lấy từ production ----------
  const uploadsHtaccess = name => path.join(dir(name), 'wp-content', 'uploads', '.htaccess');
  function uploadsProxyStatus(name) {
    const f = uploadsHtaccess(name);
    const text = exists(f) ? fs.readFileSync(f, 'utf8') : '';
    const m = /RewriteRule \^\(\.\*\)\$ (\S+?)\/wp-content\/uploads\/\$1/.exec(text);
    return { enabled: text.includes(UPLOADS_BEGIN), prodUrl: m ? m[1] : (readMeta()[name]?.prodUrl || null) };
  }
  function setUploadsProxy(name, on, prodUrl) {
    const f = uploadsHtaccess(name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    let text = exists(f) ? fs.readFileSync(f, 'utf8') : '';
    text = text.replace(new RegExp(`\\n?${UPLOADS_BEGIN}[\\s\\S]*?${UPLOADS_END}\\n?`, 'g'), '\n').trim();
    if (on) {
      const url = String(prodUrl || '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~\-\/]*)?$/i.test(url)) throw httpError(400, 'Địa chỉ production không hợp lệ, ví dụ đúng: https://shop.vn');
      setMeta(name, { prodUrl: url });
      text = [UPLOADS_BEGIN,
        '# Ảnh không có ở máy này thì lấy từ site production',
        '<IfModule mod_rewrite.c>',
        'RewriteEngine On',
        'RewriteCond %{REQUEST_FILENAME} !-f',
        `RewriteRule ^(.*)$ ${url}/wp-content/uploads/$1 [R=302,L]`,
        '</IfModule>',
        UPLOADS_END, text].filter(Boolean).join('\n') + '\n';
    }
    if (text.trim()) fs.writeFileSync(f, text.endsWith('\n') ? text : `${text}\n`);
    else fs.rmSync(f, { force: true });
  }

  // ---------- Xem qua Wi-Fi ----------
  laragon.hooks.lanChanged = async (name, port) => {
    if (!W.isWp(name)) return;
    const file = path.join(muDir(name), 'localpanel-lan.php');
    if (port) {
      fs.mkdirSync(muDir(name), { recursive: true });
      fs.writeFileSync(file, lanPlugin(port, laragon.domainOf(name)));
    } else fs.rmSync(file, { force: true });
  };

  // ---------- API ----------
  r.get('/:name', wrap(async (req, res) => {
    const name = checkWp(req.params.name);
    res.json({ shop: await shopStatus(name), uploads: uploadsProxyStatus(name), meta: readMeta()[name] || {} });
  }));
  r.post('/:name/safety', wrap(async (req, res) => {
    const name = checkWp(req.params.name);
    const out = req.body?.on ? await enableSafety(name) : await disableSafety(name, !!req.body?.restoreGateways);
    res.json({ ok: true, ...out });
  }));
  r.post('/:name/anonymize', wrap(async (req, res) => {
    const name = checkWp(req.params.name);
    res.json({ ok: true, counts: await W.withLock(name, 'được ẩn danh dữ liệu', () => anonymize(name)) });
  }));
  r.post('/:name/uploads', wrap(async (req, res) => {
    const name = checkWp(req.params.name);
    setUploadsProxy(name, !!req.body?.on, req.body?.prodUrl);
    res.json({ ok: true, ...uploadsProxyStatus(name) });
  }));

  function deleteMeta(name) {
    const all = readMeta();
    if (!(name in all)) return;
    delete all[name];
    fs.writeFileSync(metaFile(), JSON.stringify(all, null, 2));
  }
  return { router: r, enableSafety, anonymize, setUploadsProxy, setMeta, readMeta, deleteMeta, isWoo };
};
