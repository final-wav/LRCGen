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

:: 1. Check embedded python (Portable Edition)
if exist "%~dp0python_embed\python.exe" (
    set "PY_EXE=%~dp0python_embed\python.exe"
    goto :RUN
)

:: 2. Check local venv
if exist "%~dp0venv\Scripts\python.exe" (
    set "PY_EXE=%~dp0venv\Scripts\python.exe"
    goto :RUN
)

:: 3. Check system python
python --version >nul 2>&1
if not errorlevel 1 (
    set "PY_EXE=python"
    goto :RUN
)

echo [FEHLER] Kein Python gefunden!
echo Bitte fuehre zuerst install.bat aus, um die Umgebung einzurichten.
pause
exit /b 1

:RUN
echo Server startet auf: http://127.0.0.1:8001
echo Zum Beenden: Strg+C
echo.

:: Open browser after 2 seconds
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:8001"

"%PY_EXE%" -m uvicorn app:app --host 127.0.0.1 --port 8001 --log-level info --access-log
pause
