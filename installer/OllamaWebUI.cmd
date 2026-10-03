@echo off
setlocal
title Ollama WebUI
rem Launcher for the installed app. Uses the Node runtime shipped next to it,
rem so nothing has to be installed first.
rem
rem Serves on the network like start_ollama_webui.bat does for the project:
rem other devices (and, with a port forward, the internet) can reach it with
rem the access token. The first run asks for that token and sets up Claude
rem Code / Codex / agy (server\first-run.mjs).
rem
rem This file must stay ASCII with CRLF line endings.
cd /d "%~dp0app"
set "NODE=%~dp0runtime\node.exe"
rem npm (shipped beside node) and freshly installed CLIs, for this window.
set "PATH=%~dp0runtime;%USERPROFILE%\.local\bin;%APPDATA%\npm;%LOCALAPPDATA%\Antigravity;%PATH%"
if not exist ".env" if exist ".env.example" copy /y ".env.example" ".env" >nul

set "PORT=5173"
for /f "usebackq delims=" %%p in (`"%NODE%" server\setup-env.mjs --print-port 2^>nul`) do set "PORT=%%p"

curl -s -o nul -m 2 http://127.0.0.1:%PORT%/ && (
  echo Ollama WebUI is already running.
  start "" "http://localhost:%PORT%"
  exit /b 0
)

rem ---- first run: access token, CLIs ----------------------------------------
"%NODE%" server\first-run.mjs
if errorlevel 1 goto fail
for /f "usebackq delims=" %%p in (`"%NODE%" server\setup-env.mjs --print-port 2^>nul`) do set "PORT=%%p"
rem Prints the LAN addresses; HOST/token are already set by first-run.
"%NODE%" server\setup-env.mjs --network

rem ---- firewall -------------------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\server\check-firewall.ps1" >nul 2>&1
if errorlevel 1 (
  echo Opening the Windows firewall, a permission prompt will appear...
  powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0app\server\open-firewall.ps1'" >nul 2>&1
)

echo.
echo Starting Ollama WebUI on port %PORT% ...
echo Close this window to stop it.
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start "" http://localhost:%PORT%"
"%NODE%" server\index.js
if errorlevel 1 goto fail
exit /b 0

:fail
echo.
echo Ollama WebUI stopped with an error. The message above says why.
pause
