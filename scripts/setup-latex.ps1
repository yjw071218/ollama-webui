$ErrorActionPreference = 'Stop'
$directory = Join-Path $PSScriptRoot '../native/.tools/tectonic'
New-Item -ItemType Directory -Force $directory | Out-Null
$release = Invoke-RestMethod 'https://api.github.com/repos/tectonic-typesetting/tectonic/releases/latest'
$asset = $release.assets | Where-Object { $_.name -match 'x86_64-pc-windows-msvc.zip$' } | Select-Object -First 1
if (-not $asset) { throw 'Windows Tectonic package not found' }
$archive = Join-Path $directory 'tectonic.zip'
Invoke-WebRequest $asset.browser_download_url -OutFile $archive
if ($asset.digest -match '^sha256:(.+)$') {
    if ((Get-FileHash -Algorithm SHA256 $archive).Hash.ToLower() -ne $Matches[1].ToLower()) { throw 'Tectonic checksum mismatch' }
}
Expand-Archive -LiteralPath $archive -DestinationPath $directory -Force
& (Join-Path $directory 'tectonic.exe') --version
if ($LASTEXITCODE -ne 0) { throw 'Tectonic failed to start' }
