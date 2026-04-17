@echo off
echo ============================================
echo  LRC Generator starten
echo ============================================
echo.

:: Check venv
if not exist venv\Scripts\activate.bat (
    echo [FEHLER] Virtuelle Umgebung nicht gefunden.
    echo Bitte zuerst install.bat ausfuehren.
    pause
    exit /b 1
)

call venv\Scripts\activate.bat

echo Server laeuft auf http://127.0.0.1:8000
echo Browser wird geoeffnet...
echo Zum Beenden: Strg+C
echo.

:: Open browser after short delay
start /b cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:8000"

python -m uvicorn app:app --host 127.0.0.1 --port 8000
pause
