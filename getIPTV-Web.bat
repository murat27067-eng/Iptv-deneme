@echo off
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js ve npm bulunamadi. Once Node.js kurulumunu tamamla.
  pause
  exit /b 1
)

if not exist "node_modules\expo\bin\cli" (
  echo Uygulama paketleri hazirlaniyor...
  call npm install
  if errorlevel 1 (
    echo Paketler kurulamadi. Internet baglantisini kontrol et.
    pause
    exit /b 1
  )
)

echo getIPTV web arayuzu baslatiliyor. Bu pencereyi kapatma.
start "getIPTV Web Sunucusu" /D "%~dp0" cmd /k "npm run web -- --port 8082"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$url='http://localhost:8082'; $limit=(Get-Date).AddSeconds(90); while ((Get-Date) -lt $limit) { try { $r=Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2; if ($r.StatusCode -ge 200) { Start-Process $url; exit 0 } } catch {}; Start-Sleep -Seconds 1 }; Write-Host 'Web arayuzu 90 saniye icinde hazir olmadi. Sunucu penceresindeki hata mesajini kontrol et.'; pause"
endlocal
