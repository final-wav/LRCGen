@echo off
title TTML Lyrics Studio - Installer
color 0A

echo ============================================================
echo   TTML Lyrics Studio ^& LRCGen - Installation Setup
echo ============================================================
echo.

cd /d "%~dp0"

REM 1. Check if Portable Embedded Python is present
if not exist "%~dp0python_embed\python.exe" goto :CHECK_SYS_PYTHON

echo [INFO] Portable Embedded Python detected: "%~dp0python_embed"
set "PY_CMD=%~dp0python_embed\python.exe"

if exist "%~dp0python_embed\Scripts\pip.exe" goto :INSTALL_DEPS
if not exist "%~dp0python_embed\get-pip.py" goto :INSTALL_DEPS

echo [INFO] Setting up pip for embedded Python...
"%PY_CMD%" "%~dp0python_embed\get-pip.py" --no-warn-script-location
goto :INSTALL_DEPS

:CHECK_SYS_PYTHON
REM 2. Check System Python
python --version >nul 2>&1
if errorlevel 1 goto :NO_PYTHON

for /f "tokens=*" %%v in ('python --version 2^>^&1') do echo [INFO] Found: %%v

python -c "import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] <= (3, 13) else 1)" >nul 2>&1
if errorlevel 1 goto :WRONG_PYTHON

REM 3. Create venv if missing
if exist "%~dp0venv\Scripts\python.exe" goto :ACTIVATE_VENV

echo.
echo [1/5] Creating virtual Python environment in "%~dp0venv" ...
python -m venv "%~dp0venv"
if errorlevel 1 goto :VENV_ERROR

:ACTIVATE_VENV
echo [INFO] Activating virtual environment...
call "%~dp0venv\Scripts\activate.bat"
set "PY_CMD=%~dp0venv\Scripts\python.exe"

:INSTALL_DEPS
REM 4. Upgrade pip (non-fatal on Windows file locks)
echo.
echo [2/5] Updating pip...
"%PY_CMD%" -m pip install --upgrade pip --no-warn-script-location
if errorlevel 1 echo [INFO] Skipping pip upgrade, using current pip version...

REM 5. Detect GPU and Install PyTorch
echo.
echo [3/5] Checking hardware acceleration - NVIDIA GPU...
nvidia-smi >nul 2>&1
if errorlevel 1 goto :INSTALL_CPU

echo [INFO] NVIDIA GPU detected! Installing PyTorch with CUDA 12.6 for RTX 20xx/30xx/40xx/50xx...
"%PY_CMD%" -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu126 --no-warn-script-location
"%PY_CMD%" -m pip install "audio-separator[gpu]>=0.24.0" --no-warn-script-location
goto :INSTALL_WHISPERX

:INSTALL_CPU
echo [INFO] No NVIDIA GPU detected or driver not in PATH. Installing Standard CPU PyTorch...
"%PY_CMD%" -m pip install torch torchvision torchaudio --no-warn-script-location

:INSTALL_WHISPERX
REM 6. Install WhisperX into venv
echo.
echo [4/5] Installing WhisperX in venv...
"%PY_CMD%" -m pip install "whisperx>=3.1.1" --no-warn-script-location

REM 7. Install all dependencies from requirements.txt
echo.
echo [5/5] Installing all packages - FastAPI, Whisper, Pyphen, etc....
"%PY_CMD%" -m pip install -r "%~dp0requirements.txt" --no-warn-script-location
if errorlevel 1 goto :PIP_ERROR

REM 8. Verify installation
echo.
echo ============================================================
echo   Installation completed successfully!
echo ============================================================
echo.
echo Please start the studio by double-clicking: start.bat
echo When running start.bat, the browser will automatically open at:
echo http://127.0.0.1:8001
echo.
pause
exit /b 0

:NO_PYTHON
echo.
echo [ERROR] Python was not found!
echo Please install Python 3.10, 3.11, 3.12, or 3.13 from https://www.python.org/
echo IMPORTANT: Check the box "Add Python to PATH" during installation!
echo NOTE: Python 3.14+ is not yet supported by WhisperX / CTranslate2.
echo.
pause
exit /b 1

:WRONG_PYTHON
echo.
echo [WARNING / ERROR] Incompatible Python version detected!
echo LRCGen and WhisperX require Python 3.10 to 3.13.
echo Python 3.14 or newer is not yet supported by WhisperX and CTranslate2.
echo Please install Python 3.10 to 3.13.
echo.
pause
exit /b 1

:VENV_ERROR
echo.
echo [ERROR] Could not create virtual environment (venv).
echo.
pause
exit /b 1

:PIP_ERROR
echo.
echo [ERROR] An error occurred while installing packages.
echo Please check the error messages above.
echo.
pause
exit /b 1
