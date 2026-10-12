@echo off
title Game Danarakca - Server
echo.

echo   Memulai Server Game Danarakca

echo.

cd /d "%~dp0"

set "TARGET_SCRIPT="
if exist "danarakca\server.py" (
    set "TARGET_SCRIPT=danarakca\server.py"
) else if exist "server.py" (
    set "TARGET_SCRIPT=server.py"
) else if exist "web_v2\server.py" (
    set "TARGET_SCRIPT=web_v2\server.py"
)

if "%TARGET_SCRIPT%"=="" (
    echo [ERROR] File server.py tidak ditemukan di folder proyek!
    echo Pastikan folder server berada di direktori ini.
    pause
    exit /b 1
)

set PORT=8080
if not "%~1"=="" set PORT=%~1

echo Menjalankan: %TARGET_SCRIPT% di port %PORT%
echo.
echo Akses URL:
echo   - Beranda Utama    : http://localhost:%PORT%/
echo   - Login Admin      : http://localhost:%PORT%/admin
echo   - Layar Fasilitator: http://localhost:%PORT%/facilitator.html
echo   - Layar Peserta    : http://localhost:%PORT%/player.html
echo.
echo Tekan Ctrl+C untuk menghentikan server.
echo.

python "%TARGET_SCRIPT%" %PORT%
if %ERRORLEVEL% NEQ 0 (
    python3 "%TARGET_SCRIPT%" %PORT%
)
pause
