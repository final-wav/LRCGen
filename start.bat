@echo off
title TTML Lyrics Studio - Server
color 0B
set "PYTHONUNBUFFERED=1"
set "PYTHONIOENCODING=utf-8"

echo =======================================================
echo   TTML Lyrics Studio - Live Server ^& AI Console
echo =======================================================
echo.

cd /d "%~dp0"

REM 1. Check embedded python (Portable Edition)
if exist "%~dp0python_embed\python.exe" (
    set "PY_EXE=%~dp0python_embed\python.exe"
    goto :RUN
)

REM 2. Check local venv
if exist "%~dp0venv\Scripts\python.exe" (
    set "PY_EXE=%~dp0venv\Scripts\python.exe"
    goto :RUN
)

REM 3. Check system python
python --version >nul 2>&1
if not errorlevel 1 (
    set "PY_EXE=python"
    goto :RUN
)

echo [ERROR] Python not found!
echo Please run install.bat first to set up the environment.
pause
exit /b 1

:RUN
echo Server starting at: http://127.0.0.1:8001
echo To stop server: press Ctrl+C
echo.

REM Open browser after 2 seconds
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:8001"

"%PY_EXE%" -m uvicorn app:app --host 127.0.0.1 --port 8001 --reload --log-level info --access-log
pause
