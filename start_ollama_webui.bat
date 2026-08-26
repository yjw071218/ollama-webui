@echo off
title Ollama WebUI
echo ==========================================
echo   Starting Ollama and the web UI...
echo ==========================================
echo.

REM Run from wherever this file lives, so the shortcut works from any folder.
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies, one moment...
  call npm install || goto :failed
)

start http://localhost:5173
call npm run dev:all
goto :end

:failed
echo.
echo npm install failed. Is Node.js installed and on PATH?

:end
pause
