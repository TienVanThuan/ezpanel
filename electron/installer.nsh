; Bổ sung cho bộ cài EzPanel (electron-builder).
; Gặp bản cũ tPanel 2.0.x (ứng dụng khay C#): giữ lại cài đặt, sao lưu, dữ liệu vào %LOCALAPPDATA%\tPanel-ban-cu
; (EzPanel tự chuyển sang %APPDATA%\EzPanel khi mở lần đầu), ghi nhớ "chạy cùng Windows", rồi gỡ phần chương trình cũ.

!macro customInit
  ReadRegStr $0 HKCU "Software\tPanel" "InstallDir"
  ${If} $0 != ""
  ${AndIf} ${FileExists} "$0\server.js"
    nsExec::Exec 'taskkill /F /IM tPanel.exe'
    Sleep 1500
    CreateDirectory "$LOCALAPPDATA\tPanel-ban-cu"
    CreateDirectory "$LOCALAPPDATA\tPanel-ban-cu\tools"
    IfFileExists "$0\config.json" 0 +2
      CopyFiles /SILENT "$0\config.json" "$LOCALAPPDATA\tPanel-ban-cu"
    IfFileExists "$0\sites.json" 0 +2
      CopyFiles /SILENT "$0\sites.json" "$LOCALAPPDATA\tPanel-ban-cu"
    IfFileExists "$0\backups\*.*" 0 +2
      CopyFiles /SILENT "$0\backups" "$LOCALAPPDATA\tPanel-ban-cu"
    IfFileExists "$0\data\*.*" 0 +2
      CopyFiles /SILENT "$0\data" "$LOCALAPPDATA\tPanel-ban-cu"
    IfFileExists "$0\tools\php-ini\*.*" 0 +2
      CopyFiles /SILENT "$0\tools\php-ini" "$LOCALAPPDATA\tPanel-ban-cu\tools"
    ; Bản cũ có bật chạy cùng Windows: ghi dấu để EzPanel bật lại cho khóa mới
    ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "tPanel"
    ${If} $1 != ""
      FileOpen $2 "$LOCALAPPDATA\tPanel-ban-cu\autorun.txt" w
      FileWrite $2 "1"
      FileClose $2
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "tPanel"
    ${EndIf}
    RMDir /r "$0"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\tPanel"
    DeleteRegKey HKCU "Software\tPanel"
    Delete "$DESKTOP\tPanel.lnk"
    Delete "$SMPROGRAMS\tPanel.lnk"
  ${EndIf}
!macroend
