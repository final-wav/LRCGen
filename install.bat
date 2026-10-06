@echo off
title TTML Lyrics Studio - Installer
color 0A
setlocal EnableDelayedExpansion

echo ============================================================
echo   TTML Lyrics Studio & LRCGen - Installation Setup
echo ============================================================
echo.

cd /d "%~dp0"

:: 1. Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [FEHLER] Python wurde nicht gefunden!
    echo Bitte installiere Python 3.9, 3.10 oder 3.11 von https://www.python.org/
    echo WICHTIG: Setze bei der Installation das Haekchen bei "Add Python to PATH"!
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('python --version') do echo Gefunden: %%v

:: 2. Create venv if missing
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

:: 3. Upgrade pip
echo.
echo Aktualisiere pip...
python -m pip install --upgrade pip --quiet

:: 4. Detect GPU and Install PyTorch
echo.
echo Pruefe Hardware-Beschleunigung (NVIDIA GPU)...
nvidia-smi >nul 2>&1
if not errorlevel 1 (
    echo [INFO] NVIDIA GPU erkannt! Installiere PyTorch mit CUDA 12.1 fuer maximale Geschwindigkeit...
    pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
    pip install "audio-separator[gpu]>=0.24.0"
) else (
    echo [INFO] Keine NVIDIA GPU erkannt oder Treiber nicht im PATH. Installiere Standard CPU PyTorch...
    pip install torch torchvision torchaudio
)

:: 5. Install all dependencies from requirements.txt
echo.
echo Installiere alle Bibliotheken (FastAPI, Whisper, Pyphen, etc.)...
pip install -r requirements.txt

:: 6. Verify installation
echo.
echo ============================================================
echo   Installation erfolgreich abgeschlossen!
echo ============================================================
echo.
echo Du kannst das Studio jetzt jederzeit mit start.bat starten.
echo Der Server oeffnet sich automatisch auf http://127.0.0.1:8001
echo.
pause
