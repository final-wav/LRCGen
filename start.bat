@echo off
title TTML Lyrics Studio - Server
color 0B
set "PYTHONUNBUFFERED=1"
set "PYTHONIOENCODING=utf-8"

echo =======================================================
echo   TTML Lyrics Studio - Live Server und AI Console
echo =======================================================
echo.

cd /d "%~dp0"

if not exist "%~dp0venv\Scripts\python.exe" (
    echo [FEHLER] Virtuelle Umgebung nicht gefunden in %~dp0venv
    echo Bitte zuerst install.bat ausfuehren.
    pause
    exit /b 1
)

echo Server wird gestartet auf: http://127.0.0.1:8001
echo Zum Beenden: Strg+C
echo.

:: Open browser after 2 seconds
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:8001"

"%~dp0venv\Scripts\python.exe" -m uvicorn app:app --host 127.0.0.1 --port 8001 --log-level info --access-log
pause
