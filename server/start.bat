@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [1/4] Checking Nginx...
tasklist /FI "IMAGENAME eq nginx.exe" 2>nul | findstr /i "nginx.exe" >nul
if %errorlevel% neq 0 (
    echo       Nginx is not running, starting...
    cd /d C:\nginx
    start nginx.exe
    cd /d "%~dp0"
    timeout /t 2 /nobreak >nul
) else (
    echo       Nginx is already running.
)

echo [2/4] Checking port 8000...

REM Kill any existing process on port 8000
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8000 " ^| findstr "LISTENING"') do (
    echo       Killing old process PID %%a on port 8000...
    taskkill /F /PID %%a >nul 2>&1
    timeout /t 1 /nobreak >nul
)

echo [3/4] Starting AI Image Server...
echo       http://127.0.0.1:8000
echo.

echo [4/4] Done. Services are ready.
echo.
node server.js

pause
