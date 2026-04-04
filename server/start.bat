@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [1/3] Checking port 8000...

REM Kill any existing process on port 8000
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8000 " ^| findstr "LISTENING"') do (
    echo       Killing old process PID %%a on port 8000...
    taskkill /F /PID %%a >nul 2>&1
    timeout /t 1 /nobreak >nul
)

echo [2/3] Starting AI Image Server...
echo       http://127.0.0.1:8000
echo.
node server.js

pause
