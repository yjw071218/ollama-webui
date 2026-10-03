$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '.tools'
New-Item -ItemType Directory -Force $root | Out-Null
if (-not (Test-Path "$root/jdk")) {
  Invoke-WebRequest 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse' -OutFile "$root/jdk.zip"
  Expand-Archive "$root/jdk.zip" "$root/jdk-unpack" -Force
  $jdk = Get-ChildItem "$root/jdk-unpack" -Directory | Select-Object -First 1
  Move-Item -LiteralPath $jdk.FullName -Destination "$root/jdk"
}
if (-not (Test-Path "$root/gradle-8.11.1")) {
  Invoke-WebRequest 'https://services.gradle.org/distributions/gradle-8.11.1-bin.zip' -OutFile "$root/gradle.zip"
  Invoke-WebRequest 'https://services.gradle.org/distributions/gradle-8.11.1-bin.zip.sha256' -OutFile "$root/gradle.sha256"
  $expected = (Get-Content "$root/gradle.sha256" -Raw).Trim()
  if ((Get-FileHash "$root/gradle.zip" -Algorithm SHA256).Hash.ToLower() -ne $expected) { throw 'Gradle checksum mismatch' }
  Expand-Archive "$root/gradle.zip" $root -Force
}
if (-not (Test-Path "$root/android-sdk/cmdline-tools/latest/bin/sdkmanager.bat")) {
  Invoke-WebRequest 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip' -OutFile "$root/sdk.zip"
  Expand-Archive "$root/sdk.zip" "$root/sdk-unpack" -Force
  New-Item -ItemType Directory -Force "$root/android-sdk/cmdline-tools" | Out-Null
  Move-Item -LiteralPath "$root/sdk-unpack/cmdline-tools" -Destination "$root/android-sdk/cmdline-tools/latest"
}
$env:JAVA_HOME = "$root/jdk"
$env:ANDROID_HOME = "$root/android-sdk"
$env:PATH = "$env:JAVA_HOME/bin;$env:PATH"
(('y' + [Environment]::NewLine) * 100) | Set-Content "$root/sdk-answers.txt" -Encoding Ascii
cmd /d /c ('""' + "$env:ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager.bat" + '" --licenses < "' + "$root/sdk-answers.txt" + '""')
if ($LASTEXITCODE -ne 0) { throw 'SDK license acceptance failed' }
& "$env:ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager.bat" 'platforms;android-35' 'build-tools;35.0.0' 'platform-tools'
if ($LASTEXITCODE -ne 0) { throw 'SDK installation failed' }
Write-Output 'Android toolchain ready.'
