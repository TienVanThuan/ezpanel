// Chứng chỉ HTTPS cho tên miền local (giống mkcert):
//  - Một chứng chỉ gốc (CA) riêng của máy này, chỉ được phép cấp cho *.test và *.localhost (Name Constraints),
//    nên dù khóa có bị lộ cũng không giả mạo được website thật.
//  - Mỗi tên miền có chứng chỉ riêng (gồm cả *.ten.test), hạn 825 ngày, tự cấp lại khi sắp hết hạn.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const forge = require('node-forge');
const { httpError } = require('./util');

const { asn1, pki } = forge;
const isWin = process.platform === 'win32';
const DAY = 864e5;
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };

function newKey() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  return { pem, forge: pki.privateKeyFromPem(pem) };
}
const utf8Attr = (name, value) => ({ name, value, valueTagClass: asn1.Type.UTF8 }); // forge tự mã hóa UTF-8
const serial = () => '01' + crypto.randomBytes(15).toString('hex'); // số dương, 16 byte

module.exports = (config) => {
  // Chứng chỉ nằm trong <laragon>/etc/localpanel/ssl; chuyển từ vị trí cũ (thư mục Sitebench) nếu có,
  // giữ nguyên chứng chỉ gốc để không phải cài lại vào Windows
  const dirOf = () => {
    const d = config.paths.laragonData();
    const target = d ? path.join(d, 'ssl') : config.paths.ssl;
    const old = config.paths.ssl;
    if (target !== old && !exists(path.join(target, 'localpanel-ca.crt')) && exists(path.join(old, 'localpanel-ca.crt'))) {
      fs.mkdirSync(target, { recursive: true });
      for (const f of ['localpanel-ca.key', 'localpanel-ca.crt']) fs.copyFileSync(path.join(old, f), path.join(target, f));
    }
    return target;
  };
  const P = {
    get caKey() { return path.join(dirOf(), 'localpanel-ca.key'); },
    get caCrt() { return path.join(dirOf(), 'localpanel-ca.crt'); },
    get sites() { return path.join(dirOf(), 'sites'); },
  };

  // ---------- Chứng chỉ gốc ----------
  let ca = null;
  let caFrom = null;
  function loadCA() {
    const caKeyPath = P.caKey, caCrtPath = P.caCrt;
    if (ca && caFrom === caCrtPath) return ca;
    ca = null;
    if (exists(caKeyPath) && exists(caCrtPath)) {
      caFrom = caCrtPath;
      ca = { key: pki.privateKeyFromPem(fs.readFileSync(caKeyPath, 'utf8')), cert: pki.certificateFromPem(fs.readFileSync(caCrtPath, 'utf8')) };
      return ca;
    }
    return null;
  }
  function ensureCA() {
    if (loadCA()) return ca;
    const caKeyPath = P.caKey, caCrtPath = P.caCrt;
    fs.mkdirSync(P.sites, { recursive: true });
    const key = newKey();
    const cert = pki.createCertificate();
    cert.publicKey = pki.setRsaPublicKey(key.forge.n, key.forge.e);
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - DAY);
    cert.validity.notAfter = new Date(Date.now() + 10 * 365 * DAY);
    const who = `${require('os').userInfo().username}@${require('os').hostname()}`;
    const attrs = [
      utf8Attr('commonName', `LocalPanel Local CA (${who})`),
      utf8Attr('organizationName', 'LocalPanel (local development only)'),
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    // Chỉ được cấp cho .test và .localhost
    const dns = name => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.CONTEXT_SPECIFIC, 2, false, name)]);
    const allowed = ['test', 'localhost', ...(config.laragon?.domainSuffix ? [config.laragon.domainSuffix.replace(/^\./, '')] : [])];
    const nameConstraints = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [...new Set(allowed)].map(dns))]);
    cert.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true, pathLenConstraint: 0 },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
      { name: 'subjectKeyIdentifier' },
      { id: '2.5.29.30', critical: true, value: asn1.toDer(nameConstraints).getBytes() },
    ]);
    cert.sign(key.forge, forge.md.sha256.create());
    fs.writeFileSync(caKeyPath, key.pem, { mode: 0o600 });
    fs.writeFileSync(caCrtPath, pki.certificateToPem(cert));
    ca = { key: key.forge, cert };
    caFrom = caCrtPath;
    return ca;
  }
  const caSerial = () => (loadCA() ? ca.cert.serialNumber : null);

  // ---------- Chứng chỉ cho từng tên miền ----------
  function siteCert(domain) {
    if (!/^[a-z0-9.-]+$/.test(domain)) throw httpError(400, 'Tên miền không hợp lệ.');
    ensureCA();
    const crt = path.join(P.sites, `${domain}.crt`);
    const key = path.join(P.sites, `${domain}.key`);
    if (exists(crt) && exists(key)) {
      try {
        const c = pki.certificateFromPem(fs.readFileSync(crt, 'utf8'));
        const sameCA = c.issuer.hash === ca.cert.subject.hash && ca.cert.verify(c);
        if (sameCA && c.validity.notAfter.getTime() - Date.now() > 30 * DAY) return { crt, key };
      } catch { /* cấp lại */ }
    }
    fs.mkdirSync(P.sites, { recursive: true });
    const k = newKey();
    const cert = pki.createCertificate();
    cert.publicKey = pki.setRsaPublicKey(k.forge.n, k.forge.e);
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - DAY);
    cert.validity.notAfter = new Date(Date.now() + 825 * DAY);
    cert.setSubject([utf8Attr('commonName', domain), utf8Attr('organizationName', 'Sitebench')]);
    cert.setIssuer(ca.cert.subject.attributes);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: domain }, { type: 2, value: `*.${domain}` }] },
      { name: 'authorityKeyIdentifier', keyIdentifier: ca.cert.generateSubjectKeyIdentifier().getBytes() },
    ]);
    cert.sign(ca.key, forge.md.sha256.create());
    fs.writeFileSync(key, k.pem, { mode: 0o600 });
    fs.writeFileSync(crt, pki.certificateToPem(cert));
    return { crt, key };
  }

  // ---------- Tin cậy chứng chỉ gốc trên Windows ----------
  const certutil = args => new Promise(resolve => {
    execFile('certutil', args, { windowsHide: true, timeout: 180000 }, (err, out) => resolve({ ok: !err, out: out || '' }));
  });
  async function trusted() {
    if (!isWin || !loadCA()) return false;
    const r = await certutil(['-user', '-store', 'Root', caSerial()]);
    return r.ok && /LocalPanel/i.test(r.out);
  }
  async function trust() {
    if (!isWin) throw httpError(400, 'Chỉ cài chứng chỉ gốc tự động được trên Windows.');
    ensureCA();
    // Windows hiện hộp thoại cảnh báo bảo mật, người dùng bấm Yes để đồng ý
    const r = await certutil(['-user', '-addstore', 'Root', P.caCrt]);
    if (!r.ok || !(await trusted())) {
      throw httpError(400, 'Chưa cài được chứng chỉ gốc. Bạn cần bấm "Yes" ở hộp thoại cảnh báo bảo mật của Windows.');
    }
  }
  async function untrust() {
    if (!isWin || !loadCA()) return;
    await certutil(['-user', '-delstore', 'Root', caSerial()]);
  }

  return {
    ensureCA, siteCert, trusted, trust, untrust,
    reset() { ca = null; caFrom = null; }, // nạp lại chứng chỉ gốc từ đĩa (sau khi chép từ Laragon)
    removeSite(domain) {
      if (!/^[a-z0-9.-]+$/.test(domain)) return;
      for (const ext of ['crt', 'key']) fs.rmSync(path.join(P.sites, `${domain}.${ext}`), { force: true });
    },
    get caPath() { return P.caCrt; },
    hasCA: () => !!loadCA(),
    supported: isWin,
  };
};
