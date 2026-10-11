@echo off
echo.
echo    Memulai Server Game Danarakca (Hyperstudio / DESIGN.md Edition)
echo.
cd /d "%~dp0"

set PORT=8080
if not "%~1"=="" set PORT=%~1

echo Membuka server di port %PORT%...
echo.
echo Akses URL:
echo   - Beranda Utama    : http://localhost:%PORT%/
echo   - Login Admin      : http://localhost:%PORT%/admin
echo   - Layar Fasilitator: http://localhost:%PORT%/facilitator.html
echo   - Layar Peserta    : http://localhost:%PORT%/player.html
echo.
echo Tekan Ctrl+C untuk menghentikan server.
echo.
python web_v2/server.py %PORT%
pause
