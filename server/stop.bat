@echo off
chcp 65001 >nul
echo Stopping AI Image Server...

for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8000 " ^| findstr "LISTENING"') do (
    echo   Killing process PID %%a on port 8000...
    taskkill /F /PID %%a >nul 2>&1
)

echo Stopping Nginx...
tasklist /FI "IMAGENAME eq nginx.exe" 2>nul | findstr /i "nginx.exe" >nul
if %errorlevel% equ 0 (
    cd /d C:\nginx
    nginx.exe -s quit
    echo   Nginx stopped.
) else (
    echo   Nginx is not running.
)

echo Done.
pause
