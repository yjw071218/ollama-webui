@echo off
REM Convenience wrapper: starts the GPT-SoVITS inference API using the paths
REM configured in the repository's .env file.
title GPT-SoVITS API
cd /d "%~dp0.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "tts\start-tts-api.ps1"
pause
