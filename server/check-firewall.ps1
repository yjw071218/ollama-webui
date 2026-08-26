# Exits 0 when the firewall already allows the port the app is configured for.
#
# Checking only that a rule named 'Ollama WebUI' exists is not enough: after the
# port changed, the old rule still existed and still pointed at the old port, so
# the check passed while the phone stayed blocked.

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$port = 5173
$envFile = Join-Path $repoRoot '.env'
if (Test-Path $envFile) {
  $match = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($match) { $port = [int]$match.Matches[0].Groups[1].Value }
}

$rule = Get-NetFirewallRule -DisplayName 'Ollama WebUI' -ErrorAction SilentlyContinue
if (-not $rule) { exit 1 }

foreach ($r in $rule) {
  if (-not $r.Enabled) { continue }
  $ports = ($r | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue).LocalPort
  foreach ($p in $ports) {
    if ($p -eq $port -or $p -eq 'Any') { exit 0 }
  }
}

exit 1
