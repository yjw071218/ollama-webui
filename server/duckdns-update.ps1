# Points a free DuckDNS subdomain at this machine's current public address.
#
# A home connection's public IP changes whenever the ISP feels like it, so a
# bare IP is not something you can hand out. This keeps <name>.duckdns.org
# pointing at wherever the line has moved to.
#
# Settings come from .env in the repository root:
#
#   DUCKDNS_DOMAIN=yourname        (the subdomain only, no .duckdns.org)
#   DUCKDNS_TOKEN=<from duckdns.org after signing in>
#
# Run it once to check, then install it as a scheduled task:
#
#   pwsh -File server/duckdns-update.ps1 -Install
#
# Nothing here is specific to DuckDNS as a service — any provider with an HTTP
# update endpoint works the same way; only the URL changes.

[CmdletBinding()]
param(
  [string]$Domain,
  [string]$Token,
  [switch]$Install,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$taskName = 'OllamaWebUI-DuckDNS'

# --- .env ---------------------------------------------------------------
$envFile = Join-Path $repoRoot '.env'
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -notmatch '^\s*#' -and $_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
      $value = $Matches[2] -replace '^"(.*)"$', '$1' -replace "^'(.*)'$", '$1'
      Set-Item -Path "env:$($Matches[1])" -Value $value
    }
  }
}

if (-not $Domain) { $Domain = [Environment]::GetEnvironmentVariable('DUCKDNS_DOMAIN') }
if (-not $Token)  { $Token  = [Environment]::GetEnvironmentVariable('DUCKDNS_TOKEN') }

# --- scheduled task -----------------------------------------------------
if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    "Removed the scheduled task '$taskName'."
  } else {
    "No scheduled task named '$taskName'."
  }
  exit 0
}

if ($Install) {
  if (-not $Domain -or -not $Token) {
    Write-Error "DUCKDNS_DOMAIN and DUCKDNS_TOKEN must be set in .env before installing."
    exit 1
  }
  $script = Join-Path $PSScriptRoot 'duckdns-update.ps1'
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
  # Every five minutes, and once at boot: a reconnect is exactly when the
  # address changes and exactly when nothing else would trigger an update.
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
  $atBoot = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -DontStopOnIdleEnd -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

  Register-ScheduledTask -TaskName $taskName -Action $action `
    -Trigger @($trigger, $atBoot) -Settings $settings -Force | Out-Null
  "Installed '$taskName' — updates every 5 minutes and at startup."
  exit 0
}

# --- the update itself --------------------------------------------------
if (-not $Domain -or -not $Token) {
  Write-Error @"
DUCKDNS_DOMAIN and DUCKDNS_TOKEN are not set.

  1. Sign in at https://www.duckdns.org (GitHub or Google works)
  2. Claim a subdomain and copy the token shown at the top of the page
  3. Add both to .env:

       DUCKDNS_DOMAIN=yourname
       DUCKDNS_TOKEN=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
"@
  exit 1
}

# Leaving ip= empty tells DuckDNS to use the address the request came from,
# which is the right answer behind a router and avoids a second lookup.
$url = "https://www.duckdns.org/update?domains=$Domain&token=$Token&ip="

try {
  $response = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20).Content.Trim()
} catch {
  Write-Error "Could not reach DuckDNS: $($_.Exception.Message)"
  exit 1
}

if ($response -eq 'OK') {
  $seen = try { (Invoke-WebRequest -Uri 'https://api.ipify.org' -UseBasicParsing -TimeoutSec 10).Content.Trim() } catch { 'unknown' }
  "$Domain.duckdns.org -> $seen"
} else {
  # DuckDNS answers "KO" for anything wrong and never says what.
  Write-Error "DuckDNS rejected the update (replied '$response'). Check the domain and token."
  exit 1
}
