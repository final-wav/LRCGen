@echo off
echo ============================================
echo  LRC Generator - Installation
echo ============================================
echo.

:: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [FEHLER] Python nicht gefunden. Bitte Python 3.9+ installieren.
    pause
    exit /b 1
)

:: Create venv if missing
if not exist venv (
    echo Erstelle virtuelle Umgebung...
    python -m venv venv
)

:: Activate
call venv\Scripts\activate.bat

:: Upgrade pip
python -m pip install --upgrade pip --quiet

:: Core packages
echo Installiere Pakete (FastAPI, Uvicorn, Whisper)...
pip install fastapi "uvicorn[standard]" python-multipart openai-whisper

:: UVR5 vocal isolation
echo.
echo Installiere audio-separator (UVR5 Vocal Isolation)...
pip install "audio-separator[cpu]"

echo.
echo ============================================
echo  WICHTIG: PyTorch muss separat installiert
echo  werden, falls noch nicht vorhanden.
echo.
echo  CPU (Standard):
echo    pip install torch torchvision torchaudio
echo.
echo  CUDA 12.1 (NVIDIA GPU - viel schneller!):
echo    pip install torch torchvision torchaudio ^
echo      --index-url https://download.pytorch.org/whl/cu121
echo.
echo  GPU-Beschleunigung fuer audio-separator:
echo    pip install "audio-separator[gpu]"
echo ============================================
echo.
echo Installation abgeschlossen! Starte mit start.bat
pause
