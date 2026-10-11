param([string]$Version = '')
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifacts = [IO.Path]::GetFullPath((Join-Path $project 'native\artifacts'))
$destination = [IO.Path]::GetFullPath((Join-Path $artifacts 'office-runtime'))
$downloads = [IO.Path]::GetFullPath((Join-Path $artifacts 'office-runtime-download'))
if (-not $destination.StartsWith($artifacts + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected runtime destination.' }
if (Test-Path -LiteralPath (Join-Path $destination 'program\soffice.exe')) { Write-Output "Office engine is ready: $destination"; exit 0 }
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
$arguments = @('download', '--id', 'TheDocumentFoundation.LibreOffice', '--exact', '--source', 'winget', '--download-directory', $downloads, '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity')
if ($Version) { $arguments += @('--version', $Version) }
& winget @arguments
if ($LASTEXITCODE -ne 0) { throw 'LibreOffice download or package hash verification failed.' }
$installer = Get-ChildItem -LiteralPath $downloads -Filter 'LibreOffice*.msi' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) { throw 'LibreOffice MSI was not downloaded.' }
# Administrative extraction creates a project-local runtime, without changing
# the user's default Office applications or file associations.
$installArgs = @('/a', ('"' + $installer.FullName + '"'), '/qn', ('TARGETDIR="' + $destination + '"'), '/norestart', '/l*v', ('"' + (Join-Path $artifacts 'office-runtime-extract.log') + '"'))
$process = Start-Process -FilePath msiexec.exe -ArgumentList $installArgs -WindowStyle Hidden -PassThru -Wait
if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $destination 'program\soffice.exe'))) { throw "LibreOffice extraction failed: $($process.ExitCode)" }
Write-Output "Office engine is ready: $destination"
