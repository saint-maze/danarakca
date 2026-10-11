@echo off
title Game Danarakca - Server
echo.
echo ========================================================
echo   Memulai Server Game Danarakca (DESIGN.md Edition)
echo ========================================================
echo.
echo Akses URL:
echo   - Beranda Utama    : http://localhost:8080/
echo   - Login Admin      : http://localhost:8080/admin
echo   - Layar Fasilitator: http://localhost:8080/facilitator.html
echo   - Layar Peserta    : http://localhost:8080/player.html
echo.
python web_v2\server.py 8080
if %ERRORLEVEL% NEQ 0 (
    python3 web_v2\server.py 8080
)
pause
