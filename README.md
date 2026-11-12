# Sitebench

Bảng điều khiển máy chủ local cho Windows: Apache, PHP, MySQL/MariaDB, WordPress/WooCommerce, HTTPS, email thử (Mailpit), terminal, sao lưu. Chạy độc lập (tự quản lý máy chủ) hoặc dùng Laragon có sẵn.

> Trước đây có tên **EzPanel** (và tPanel, LocalPanel). Bản 3.0.9 tự cập nhật thẳng từ EzPanel: dữ liệu `%APPDATA%\EzPanel` được chuyển sang `%APPDATA%\Sitebench`, giữ mật khẩu, cài đặt, sao lưu và chế độ chạy cùng Windows. Máy chủ (ví dụ `D:\tPanel`), dự án và database giữ nguyên. Tên các tệp kỹ thuật (`.tpanel.json`, `tpanel.json`, `ezpanel-ca.php`…) được giữ để không ảnh hưởng dự án.

## Cài đặt

Chạy `Sitebench-Setup-x.y.z.exe`. Không cần quyền admin, không cần cài gì trước (Node.js đã có sẵn bên trong). Windows có thể báo "Windows protected your PC" vì bộ cài chưa ký số: bấm **More info → Run anyway**.

Lần đầu mở, trình hướng dẫn giúp đặt mật khẩu và chọn:

- **Sitebench tự quản lý máy chủ** (khuyên dùng): tải Apache (Apache Lounge), PHP (windows.php.net), MySQL (dev.mysql.com) hoặc MariaDB, Node.js LTS (cho npm trong terminal dự án); tự tạo cấu hình, khởi tạo database. Mọi dự án chạy PHP qua FastCGI, giống PHP-FPM trên hosting.
- **Dùng Laragon đã cài**: Sitebench tự tìm Laragon trên các ổ đĩa.

## Ứng dụng

- Cửa sổ riêng (Electron), biểu tượng ở khay hệ thống với hai đèn Apache / MySQL; đóng cửa sổ thì thu vào khay, Apache/MySQL vẫn chạy. Thoát hẳn: chuột phải biểu tượng → Thoát Sitebench.
- Chạy cùng Windows: Cài đặt → Ứng dụng desktop, hoặc menu khay.
- Ô đường dẫn có nút **Chọn…** (hộp thoại chọn thư mục của Windows).
- Dữ liệu của Sitebench (cài đặt, sao lưu, nhật ký, công cụ): `%APPDATA%\Sitebench`. Gỡ cài đặt không xóa dữ liệu này, cũng không xóa thư mục máy chủ.

## Tính năng

- **Máy chủ & dự án**: PHP riêng cho từng dự án, HTTPS (chứng chỉ gốc chỉ cho .test/.localhost), xem qua Wi-Fi, tên miền tự động, tìm kiếm, xóa có sao lưu.
- **WordPress**: cài mới (Tiếng Việt / English / 日本語, template), cập nhật, sao lưu, nhân bản, an toàn cho shop WooCommerce, ẩn danh khách hàng, ảnh từ production.
- **Template**: thư mục, zip hoặc Git; tự nhận diện giao diện / plugin / wp-content / bộ khung site (như wp-vite-starter); tệp `tpanel.json` mô tả các bước thiết lập; `.tpanel.json` ở gốc dự án cho BrowserSync/Vite (địa chỉ site, chứng chỉ localhost).
- **Nhập site**: từ tệp sao lưu, qua SSH, hoặc chuyển từ Laragon (mã nguồn, database, PHP, HTTPS, chứng chỉ).
- **Sao lưu**: mọi dự án, kể cả đã xóa; khôi phục với tên cũ hoặc tên mới.
- **Database**, **Email** (Mailpit), **Nhật ký**, **Terminal**, **Quản lý file**, **Website tĩnh**, **Dịch vụ Windows**.
- **Cài đặt**: chế độ máy chủ, phiên bản Apache/PHP/MySQL/Node.js, cổng, ứng dụng, bảo mật, cập nhật.

## Cập nhật

**Sitebench** (Cài đặt → Cập nhật):
- **Tự tải bản mới** (mặc định bật): kiểm tra 1 phút sau khi mở rồi mỗi 6 giờ, tải ngầm phần thay đổi, **cài khi thoát Sitebench** (Apache/MySQL vẫn chạy); có nút **Cài ngay**. Tắt công tắc thì chỉ báo khi có bản mới.
- **Bản thử nghiệm**: khi phát hành, tick "Bản thử nghiệm" → bản được đánh dấu Pre-release, chỉ máy bật **Nhận bản thử nghiệm** mới nhận. Thử ổn thì trên GitHub sửa bản phát hành: bỏ "Set as a pre-release", chọn "Set as the latest release" → mọi máy tự nhận.
- **Từ tệp bộ cài**: chọn `Sitebench-Setup-x.y.z.exe`; Sitebench tắt, cài đè im lặng (giữ dữ liệu) rồi tự mở lại.
- **Tự động qua GitHub Releases**: nhập kho GitHub (chu-so-huu/ten-kho); Sitebench kiểm tra, tải phần thay đổi (blockmap) và cài khi bấm.

**Phần mềm đi kèm** (máy chủ độc lập): PHP, Apache, MySQL/MariaDB cùng dòng có sao lưu và quay lại; nâng cấp database khác dòng bằng xuất/nạp dữ liệu.

## Phát triển

```
npm install
npm start            # chạy bản desktop (Electron)
npm run server       # chỉ chạy phần xử lý, mở http://localhost:2083
npm run dist         # dựng bộ cài Windows vào dist/ (trên Linux cần Wine 32 và 64 bit)
```

Phát hành: đặt mã nguồn lên GitHub, rồi `git tag v3.0.1 && git push --tags`. Quy trình `.github/workflows/release.yml` dựng bộ cài trên Windows và đăng lên Releases (kèm `latest.yml` và `.blockmap` cho tự cập nhật). Nhớ tăng `version` trong `package.json` trước khi gắn thẻ.

Cấu trúc:

```
electron/main.js       Cửa sổ, khay, chạy phần xử lý, chạy cùng Windows, cập nhật
electron/preload.js    Cầu nối an toàn cho giao diện (chọn thư mục, cập nhật…)
electron/installer.nsh Bổ sung bộ cài: chuyển dữ liệu từ tPanel 2.0.x
server.js              Phần xử lý (Express) — dữ liệu ở TPANEL_DATA
lib/                   Các module: laragon, runtime (máy chủ độc lập), wordpress, projects, updates…
public/                Giao diện
```
