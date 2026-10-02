@echo off
setlocal
title Ollama WebUI
rem Launcher for the installed app. Uses the Node runtime shipped next to it,
rem so nothing has to be installed first. Listens on this PC only; to reach it
rem from a phone, set HOST and a token in .env (see README).
cd /d "%~dp0app"
set "NODE=%~dp0runtime\node.exe"
if not exist ".env" if exist ".env.example" copy /y ".env.example" ".env" >nul
if not defined HOST set "HOST=127.0.0.1"
set "PORT=5173"
for /f "usebackq delims=" %%p in (`"%NODE%" server\setup-env.mjs --print-port 2^>nul`) do set "PORT=%%p"

curl -s -o nul -m 2 http://127.0.0.1:%PORT%/ && (
  echo Ollama WebUI is already running.
  start "" "http://localhost:%PORT%"
  exit /b 0
)

echo Starting Ollama WebUI on http://localhost:%PORT% ...
echo Close this window to stop it.
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start "" http://localhost:%PORT%"
"%NODE%" server\index.js
if errorlevel 1 (
  echo.
  echo Ollama WebUI stopped with an error. The message above says why.
  pause
)
