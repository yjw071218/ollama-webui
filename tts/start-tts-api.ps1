# Starts the GPT-SoVITS inference API that the web UI talks to over /tts-api.
#
# Nothing here is machine-specific: every path comes from .env (see
# .env.example). That is what lets this file live in the repository while the
# install it points at — weights, voices, a 25 GB runtime — stays out of it.

[CmdletBinding()]
param(
  [string]$Root,        # GPT-SoVITS checkout
  [string]$Python,      # python.exe to run it with
  [string]$FfmpegBin,   # folder holding ffmpeg.exe, prepended to PATH
  [string]$ConfigPath,  # tts_infer.yaml, relative to $Root
  [string]$BindHost,
  [int]$Port
)

$ErrorActionPreference = 'Stop'

# Values passed in win; otherwise fall back to .env, then to a sensible default.
function Resolve-Setting {
  param([string]$Passed, [string]$Key, [string]$Default)
  if ($Passed) { return $Passed }
  $fromEnv = [Environment]::GetEnvironmentVariable($Key)
  if ($fromEnv) { return $fromEnv }
  return $Default
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot '.env'
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$') {
      $value = $Matches[2] -replace '^"(.*)"$', '$1' -replace "^'(.*)'$", '$1'
      Set-Item -Path "env:$($Matches[1])" -Value $value
    }
  }
}

$Root       = Resolve-Setting $Root       'GPT_SOVITS_PATH'   ''
$Python     = Resolve-Setting $Python     'GPT_SOVITS_PYTHON' 'python'
$FfmpegBin  = Resolve-Setting $FfmpegBin  'FFMPEG_BIN'        ''
$ConfigPath = Resolve-Setting $ConfigPath 'GPT_SOVITS_CONFIG' 'GPT_SoVITS/configs/tts_infer.yaml'
$BindHost   = Resolve-Setting $BindHost   'TTS_HOST'          '127.0.0.1'
if (-not $Port) { $Port = [int](Resolve-Setting '' 'TTS_PORT' '9880') }

if (-not $Root) {
  Write-Error "GPT_SOVITS_PATH is not set. Copy .env.example to .env and point it at your GPT-SoVITS folder."
  exit 1
}
if (-not (Test-Path $Root)) {
  Write-Error "GPT_SOVITS_PATH does not exist: $Root"
  exit 1
}

Set-Location -Path $Root

# GPT-SoVITS shells out to ffmpeg for anything that is not already 32 kHz wav.
if ($FfmpegBin -and (Test-Path $FfmpegBin)) {
  $env:PATH = "$FfmpegBin;$env:PATH"
}

Write-Host "GPT-SoVITS  : $Root"
Write-Host "python      : $Python"
Write-Host "listening on: http://${BindHost}:${Port}"

& $Python api_v2.py -a $BindHost -p $Port -c $ConfigPath
