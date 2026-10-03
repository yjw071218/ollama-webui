$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '.tools'
$env:JAVA_HOME = "$root/jdk"
$env:ANDROID_HOME = "$root/android-sdk"
$env:PATH = "$env:JAVA_HOME/bin;$env:PATH"
# Persistent local signing identity. Never print, commit, or upload this directory.
$secret = "$root/android-signing.json"
if (-not (Test-Path $secret)) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $password = [Convert]::ToBase64String($bytes)
    @{ password = $password } | ConvertTo-Json | Set-Content $secret
    & "$env:JAVA_HOME/bin/keytool.exe" -genkeypair -keystore "$root/ollama-client-release.jks" -storepass $password -keypass $password -alias ollama-client -keyalg RSA -keysize 3072 -validity 10000 -dname "CN=Ollama WebUI Client, O=Ollama WebUI"
    if ($LASTEXITCODE -ne 0) { throw 'Signing key generation failed' }
}
$signing = Get-Content $secret -Raw | ConvertFrom-Json
$env:ANDROID_KEYSTORE = "$root/ollama-client-release.jks"
$env:ANDROID_STORE_PASSWORD = $signing.password
$env:ANDROID_KEY_PASSWORD = $signing.password
$env:ANDROID_KEY_ALIAS = 'ollama-client'
Push-Location "$PSScriptRoot/android"
try {
    & "$root/gradle-8.11.1/bin/gradle.bat" --no-daemon assembleRelease lintRelease
    if ($LASTEXITCODE -ne 0) { throw 'Android build or lint failed' }
    New-Item -ItemType Directory -Force "$PSScriptRoot/artifacts/android" | Out-Null
    Copy-Item 'app/build/outputs/apk/release/app-release.apk' "$PSScriptRoot/artifacts/android/OllamaWebUI-Client-1.0.3.apk"
    & "$env:ANDROID_HOME/build-tools/35.0.0/apksigner.bat" verify --verbose "$PSScriptRoot/artifacts/android/OllamaWebUI-Client-1.0.3.apk"
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed' }
} finally {
    Pop-Location
    Remove-Item Env:ANDROID_STORE_PASSWORD,Env:ANDROID_KEY_PASSWORD -ErrorAction SilentlyContinue
}
