param([Parameter(Mandatory=$true)][string]$SourceFile,
      [Parameter(Mandatory=$true)][string]$TargetFile,
      [ValidateSet('HWP','HWPX')][string]$Format = 'HWPX',
      [switch]$TextInput)
$ErrorActionPreference = 'Stop'
$hwp = $null
try {
  $hwp = New-Object -ComObject HWPFrame.HwpObject
  $hwp.XHwpWindows.Item(0).Visible = $false
  if ($TextInput) {
    $content = [IO.File]::ReadAllText($SourceFile, [Text.Encoding]::UTF8)
    if (-not $hwp.SetTextFile($content, 'TEXT', '')) { throw 'Could not insert document text.' }
  } else {
    if (-not $hwp.Open($SourceFile, '', 'forceopen:true')) { throw 'Could not open the document.' }
  }
  if (-not $hwp.SaveAs($TargetFile, $Format, '')) { throw 'Could not save the document.' }
} finally {
  if ($null -ne $hwp) {
    try { $hwp.Clear(1); $hwp.Quit() } catch {}
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($hwp)
  }
}
