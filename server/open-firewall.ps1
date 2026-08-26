# Opens the Windows firewall for the web UI's port.
#
# Windows blocks inbound connections to a Node process by default, which is why
# a server that works on localhost is unreachable from a phone on the same
# wifi. This adds one narrow rule rather than the "allow everything" prompt
# Windows shows the first time a program listens.
#
# Needs an elevated PowerShell. Run with -Remove to take the rule away again.

[CmdletBinding()]
param(
  [int]$Port,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$ruleName = 'Ollama WebUI'

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Error "Run this from an elevated PowerShell (right-click > Run as administrator)."
  exit 1
}

if ($Remove) {
  Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  "Removed the firewall rule '$ruleName'."
  exit 0
}

# The port comes from .env unless one is passed explicitly.
if (-not $Port) {
  $envFile = Join-Path (Split-Path -Parent $PSScriptRoot) '.env'
  if (Test-Path $envFile) {
    $match = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
    if ($match) { $Port = [int]$match.Matches[0].Groups[1].Value }
  }
}
if (-not $Port) { $Port = 8080 }

Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule

New-NetFirewallRule -DisplayName $ruleName `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
  -Profile Private, Public `
  -Description 'Inbound HTTP for the Ollama web UI' | Out-Null

"Allowed inbound TCP $Port."
""
"Reachable now from this network at:"
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
  ForEach-Object { "  http://$($_.IPAddress):$Port" }
""
"For access from outside the house you still need a port forward on the router"
"(external $Port -> this machine, TCP). See server/README.md."
