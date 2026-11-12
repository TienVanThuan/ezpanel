// Đặt số phiên bản (từ nút "Run workflow" hoặc từ thẻ vX.Y.Z) và nơi đăng bản phát hành cho electron-builder.
// RELEASE_REPO (biến của kho, tùy chọn): đăng bộ cài sang một kho Public khác, giữ kho mã nguồn ở chế độ Private.
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const fromTag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME.replace(/^v/, '') : '';
const version = String(process.env.INPUT_VERSION || fromTag || p.version).trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Số phiên bản không hợp lệ: "${version}" (đúng dạng: 3.0.6)`);
const [owner, repo] = String(process.env.RELEASE_REPO || process.env.GITHUB_REPOSITORY).split('/');
p.version = version;
// Cấu hình nơi đăng: electron-builder cần để sinh latest.yml (việc tải lên do bước gh release của quy trình làm)
p.build.publish = [{ provider: 'github', owner, repo, releaseType: 'draft' }];
p.ezpanelUpdateRepo = `${owner}/${repo}`; // Sitebench dùng làm nguồn tự cập nhật mặc định
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));
console.log(`Sitebench ${version} → đăng lên https://github.com/${owner}/${repo}/releases`);
