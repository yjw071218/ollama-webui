@echo off
setlocal
title Ollama WebUI

rem Starts Ollama and the web UI on an address other devices can reach, so a
rem phone on the same wifi can just open the printed link.
rem
rem Every step is idempotent: run this as often as you like.
rem
rem This file must stay ASCII with CRLF line endings. cmd.exe cannot parse a
rem batch file with LF-only endings and will close the window without a word.

cd /d "%~dp0"

echo ==========================================
echo    Ollama WebUI
echo ==========================================
echo.

rem ---- prerequisites -------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found on PATH.
  echo Install it from https://nodejs.org and run this again.
  goto fail
)

if not exist "node_modules" (
  echo Installing dependencies, this happens once...
  call npm install
  if errorlevel 1 goto fail
  echo.
)

rem ---- configuration -------------------------------------------------------
if not exist ".env" (
  if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
    echo Created .env from .env.example.
  ) else (
    type nul > ".env"
  )
)

rem Serving to other devices means binding beyond loopback, which the server
rem refuses to do without a token. Generate one on the first run and keep it.
node "server\setup-env.mjs" --network
if errorlevel 1 goto fail
echo.

rem ---- ollama --------------------------------------------------------------
rem Only the fact that something answers on 11434 matters, not how it got there.
curl -s -o nul -m 3 http://127.0.0.1:11434/api/tags
if errorlevel 1 (
  echo Starting Ollama...
  start "Ollama" /min cmd /c "ollama serve"
  timeout /t 3 /nobreak >nul
) else (
  echo Ollama is already running.
)

rem ---- firewall ------------------------------------------------------------
rem Windows blocks inbound connections to node.exe by default, which is exactly
rem why a server that works locally is invisible to a phone. Ask for the rule
rem once rather than letting it fail quietly later.
powershell -NoProfile -Command "if (Get-NetFirewallRule -DisplayName 'Ollama WebUI' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo Opening the Windows firewall, a permission prompt will appear...
  powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0server\open-firewall.ps1'" >nul 2>&1
  echo.
)

rem ---- build and run -------------------------------------------------------
echo Building the app...
call npm run build
if errorlevel 1 goto fail
echo.

rem Open the desktop browser on the local address. The server prints the ones a
rem phone should use.
set "PORT=5173"
for /f "usebackq delims=" %%p in (`node "server\setup-env.mjs" --print-port`) do set "PORT=%%p"
start "" "http://localhost:%PORT%"

node "server\index.js"
if errorlevel 1 goto fail
goto done

:fail
echo.
echo ------------------------------------------
echo  Startup failed. The message above says why.
echo ------------------------------------------

:done
echo.
echo Press any key to close this window.
pause >nul
