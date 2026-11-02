@echo off
title TTML Lyrics Studio - Installer
color 0A
setlocal EnableDelayedExpansion

echo ============================================================
echo   TTML Lyrics Studio & LRCGen - Installation Setup
echo ============================================================
echo.

cd /d "%~dp0"

:: 1. Check if Portable Embedded Python is present
if exist "%~dp0python_embed\python.exe" (
    echo [INFO] Portables Embedded Python erkannt (%~dp0python_embed)!
    set "PY_CMD=%~dp0python_embed\python.exe"
    
    :: Ensure pip is installed in embedded python
    if not exist "%~dp0python_embed\Scripts\pip.exe" (
        if exist "%~dp0python_embed\get-pip.py" (
            echo Richte pip fuer portables Python ein...
            "%PY_CMD%" "%~dp0python_embed\get-pip.py" --no-warn-script-location --quiet
        )
    )
    goto :INSTALL_DEPS
)

:: 2. Check System Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [FEHLER] Python wurde nicht gefunden!
    echo Bitte installiere Python 3.10, 3.11, 3.12 oder 3.13 von https://www.python.org/
    echo WICHTIG: Setze bei der Installation das Haekchen bei "Add Python to PATH"!
    echo HINWEIS: Python 3.14+ wird von WhisperX/CTranslate2 noch nicht unterstuetzt.
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('python --version') do echo Gefunden: %%v

python -c "import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] <= (3, 13) else 1)" >nul 2>&1
if errorlevel 1 (
    echo.
    echo [WARNUNG / FEHLER] Inkompatible Python-Version erkannt!
    echo LRCGen und WhisperX erfordern Python 3.10 bis 3.13.
    echo Python 3.14 oder neuer wird von WhisperX und CTranslate2 noch nicht unterstuetzt.
    echo Bitte installiere Python 3.10 bis 3.13.
    echo.
    pause
    exit /b 1
)

:: 3. Create venv if missing
if not exist "venv\Scripts\python.exe" (
    echo.
    echo Erstelle virtuelle Python-Umgebung in %~dp0venv ...
    python -m venv venv
    if errorlevel 1 (
        echo [FEHLER] Konnte venv nicht erstellen.
        pause
        exit /b 1
    )
)

echo Aktiviere virtuelle Umgebung...
call venv\Scripts\activate.bat
set "PY_CMD=%~dp0venv\Scripts\python.exe"

:INSTALL_DEPS
:: 4. Upgrade pip
echo.
echo Aktualisiere pip...
"%PY_CMD%" -m pip install --upgrade pip --quiet --no-warn-script-location

:: 5. Detect GPU and Install PyTorch
echo.
echo Pruefe Hardware-Beschleunigung (NVIDIA GPU)...
nvidia-smi >nul 2>&1
if not errorlevel 1 (
    echo [INFO] NVIDIA GPU erkannt! Installiere PyTorch mit CUDA 12.6 fuer RTX 20xx/30xx/40xx/50xx...
    "%PY_CMD%" -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu126 --no-warn-script-location
    "%PY_CMD%" -m pip install "audio-separator[gpu]>=0.24.0" --no-warn-script-location
) else (
    echo [INFO] Keine NVIDIA GPU erkannt oder Treiber nicht im PATH. Installiere Standard CPU PyTorch...
    "%PY_CMD%" -m pip install torch torchvision torchaudio --no-warn-script-location
)

:: 6. Install WhisperX into venv
echo.
echo Installiere WhisperX in venv...
"%PY_CMD%" -m pip install whisperx>=3.1.1 --no-warn-script-location

:: 7. Install all dependencies from requirements.txt
echo.
echo Installiere alle Bibliotheken (FastAPI, Whisper, Pyphen, etc.)...
"%PY_CMD%" -m pip install -r "%~dp0requirements.txt" --no-warn-script-location

:: 8. Verify installation
echo.
echo ============================================================
echo   Installation erfolgreich abgeschlossen!
echo ============================================================
echo.
echo Du kannst das Studio jetzt jederzeit mit start.bat starten.
echo Der Server oeffnet sich automatisch auf http://127.0.0.1:8001
echo.
pause
