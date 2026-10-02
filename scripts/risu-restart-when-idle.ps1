param(
    [Parameter(Mandatory = $true)][int]$ExpectedPid,
    [Parameter(Mandatory = $true)][long]$ExpectedStartTicks,
    [string]$ComfyUrl = 'http://127.0.0.1:8188',
    [string]$WebUiUrl = 'http://127.0.0.1:5173',
    [int]$IdleSeconds = 30
)

# One-shot restart requested by the user. It never cancels a ComfyUI job and
# never starts a server if the original process was stopped/replaced elsewhere.
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskLogDir = Join-Path $taskRoot 'logs'
New-Item -ItemType Directory -Path $taskLogDir -Force | Out-Null
$taskLog = Join-Path $taskLogDir 'risu-restart.log'
function Write-TaskLog([string]$Message) {
    Add-Content -LiteralPath $taskLog -Value "$(Get-Date -Format o) $Message"
}
function Get-OriginalServer {
    $serverProcess = Get-Process -Id $ExpectedPid -ErrorAction SilentlyContinue
    if (!$serverProcess -or $serverProcess.StartTime.ToUniversalTime().Ticks -ne $ExpectedStartTicks) { return $null }
    $serverInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedPid"
    if ($serverInfo.CommandLine -notmatch 'server[\\/]index\.js') { return $null }
    return $serverProcess
}

try {
    if (!(Test-Path -LiteralPath (Join-Path $taskRoot 'dist/index.html')) -or
        !(Test-Path -LiteralPath (Join-Path $taskRoot 'integrations/risuai/upstream/dist/version.json'))) {
        throw 'Builds are missing; refusing to stop the server.'
    }
    Write-TaskLog "Watching ComfyUI; will restart WebUI process $ExpectedPid after $IdleSeconds seconds with an empty queue."
    $idleSince = $null
    $lastState = ''
    while ($true) {
        $serverProcess = Get-OriginalServer
        if (!$serverProcess) { Write-TaskLog 'Original server stopped or changed. Exiting without a restart.'; exit 0 }
        try {
            $queue = Invoke-RestMethod -Uri "$ComfyUrl/queue" -TimeoutSec 10
            if ($null -eq $queue.queue_running -or $null -eq $queue.queue_pending) { throw 'Invalid queue response' }
            $running = @($queue.queue_running).Count
            $pending = @($queue.queue_pending).Count
            $state = "running=$running pending=$pending"
            if ($state -ne $lastState) { Write-TaskLog $state; $lastState = $state }
            if ($running -eq 0 -and $pending -eq 0) {
                if (!$idleSince) { $idleSince = Get-Date }
                if (((Get-Date) - $idleSince).TotalSeconds -ge $IdleSeconds) { break }
            } else { $idleSince = $null }
        } catch {
            $idleSince = $null
            if ($lastState -ne 'queue-unavailable') { Write-TaskLog 'Queue unavailable; leaving server running.'; $lastState = 'queue-unavailable' }
        }
        Start-Sleep -Seconds 5
    }
    $serverProcess = Get-OriginalServer
    if (!$serverProcess) { Write-TaskLog 'Original server changed before restart. Exiting.'; exit 0 }
    $nodePath = $serverProcess.Path
    Write-TaskLog 'Queue idle. Restarting WebUI now.'
    Stop-Process -Id $ExpectedPid
    Wait-Process -Id $ExpectedPid -Timeout 15 -ErrorAction SilentlyContinue
    $newServer = Start-Process -FilePath $nodePath -ArgumentList 'server/index.js' -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $taskLogDir 'risu-webui.stdout.log') `
        -RedirectStandardError (Join-Path $taskLogDir 'risu-webui.stderr.log')
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Seconds 2
        try {
            $status = Invoke-RestMethod -Uri "$WebUiUrl/risuai/status" -TimeoutSec 5
            if ($status.installed -eq $true) {
                Write-TaskLog "Complete. New server PID $($newServer.Id); RisuAI route verified."
                exit 0
            }
        } catch { }
        if ($newServer.HasExited) { break }
    }
    throw 'Restart did not pass the RisuAI health check. See risu-webui.stderr.log.'
} catch {
    Write-TaskLog "Failed: $($_.Exception.Message)"
    exit 1
}
