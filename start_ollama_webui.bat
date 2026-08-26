@echo off
setlocal EnableDelayedExpansion
title Ollama WebUI

REM Starts Ollama and the web UI on an address other devices can reach, so a
REM phone on the same wifi can just open the printed link.
REM
REM Everything below is idempotent: run it as often as you like.

cd /d "%~dp0"

echo ==========================================
echo   Ollama WebUI
echo ==========================================
echo.

REM ---- prerequisites -------------------------------------------------------
where node >nul 2>&1 || (
  echo Node.js was not found on PATH.
  echo Install it from https://nodejs.org and run this again.
  goto :fail
)

if not exist node_modules (
  echo Installing dependencies, this happens once...
  call npm install || goto :fail
  echo.
)

REM ---- configuration -------------------------------------------------------
REM A first run has no .env; create one from the example so the settings below
REM have somewhere to live.
if not exist .env (
  if exist .env.example (
    copy /y .env.example .env >nul
    echo Created .env from .env.example.
  ) else (
    type nul > .env
  )
)

REM Serving to other devices means binding beyond loopback, which the server
REM refuses to do without a token. Generate one on first run and keep it.
node server\setup-env.mjs --network || goto :fail
echo.

REM ---- ollama --------------------------------------------------------------
REM `ollama serve` fails loudly if it is already running, which is fine — the
REM point is only that something is listening on 11434.
curl -s -o nul -m 3 http://127.0.0.1:11434/api/tags 2>nul
if errorlevel 1 (
  echo Starting Ollama...
  start "Ollama" /min cmd /c "ollama serve"
  REM Give it a moment to bind before the UI asks it for a model list.
  timeout /t 3 /nobreak >nul
) else (
  echo Ollama is already running.
)

REM ---- firewall ------------------------------------------------------------
REM Windows blocks inbound connections to node.exe by default, which is exactly
REM why a server that works locally is invisible to a phone. Adding the rule
REM needs elevation, so ask for it once rather than failing silently later.
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "if (-not (Get-NetFirewallRule -DisplayName 'Ollama WebUI' -ErrorAction SilentlyContinue)) { exit 1 } else { exit 0 }"
  if errorlevel 1 (
    echo Opening the Windows firewall ^(a permission prompt will appear^)...
    powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"%~dp0server\open-firewall.ps1\"'" 2>nul
    echo.
  )
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\open-firewall.ps1" >nul 2>&1
)

REM ---- build and run -------------------------------------------------------
echo Building the app...
call npm run build || goto :fail
echo.

REM The server prints every address it can be reached at; open the local one
REM here so the desktop browser lands on the app rather than a blank tab.
for /f "usebackq tokens=*" %%p in (`node -e "const e=require('fs').existsSync('.env')?require('fs').readFileSync('.env','utf8'):'';const m=e.match(/^\s*PORT\s*=\s*(\d+)/m);process.stdout.write(m?m[1]:'8080')"`) do set PORT=%%p
start "" "http://localhost:!PORT!"

node server\index.js
goto :end

:fail
echo.
echo Startup failed. The message above says why.

:end
echo.
pause
