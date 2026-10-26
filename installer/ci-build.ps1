<#
    CI entry point for the Windows installer.

    The workflow that calls this stays deliberately tiny so the build logic lives
    in the repository with the rest of the project, not in YAML: this script
    guarantees Inno Setup, runs installer\build-installer.ps1, adds Microsoft's
    WebView2 runtime bootstrapper to the payload and recompiles setup so the
    installer can put the runtime back on a PC that never had it, then prints a
    public download link.

    The rebuild costs about two seconds because the native binaries and the web
    UI are already on disk; only ISCC runs again.

    Run it the same way locally if you want exactly what CI produces:

        powershell -ExecutionPolicy Bypass -File installer\ci-build.ps1
#>

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$iscc = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'

if (-not (Test-Path $iscc)) {
    Write-Host '== Inno Setup 6 is not on this machine; installing it'
    choco install innosetup --no-progress -y
    if ($LASTEXITCODE -ne 0) { throw 'Inno Setup 6 could not be installed.' }
}

& (Join-Path $PSScriptRoot 'build-installer.ps1')

$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$buildDir = Join-Path $root 'native\build\HybridStudio_artefacts\Release'

# Windows draws this app's whole interface with the WebView2 runtime. Microsoft
# ships it with Edge on most machines, but a PC that never received it starts the
# app into an empty window. Setup can install it for the user - provided the
# bootstrapper is inside the payload, which is what this block adds. Without it
# setup still installs and the app explains what is missing instead of showing a
# blank window, so a failed download is a warning, not an error.
$webviewSetup = Join-Path $buildDir 'MicrosoftEdgeWebView2Setup.exe'
if (-not (Test-Path $webviewSetup)) {
    Write-Host ''
    Write-Host '== Fetching the Microsoft WebView2 bootstrapper' -ForegroundColor Cyan
    $webviewUrl = 'https://go.microsoft.com/fwlink/p/?LinkId=' + '2124703'
    curl.exe -sSL --max-time 300 -o $webviewSetup $webviewUrl
    if (-not (Test-Path $webviewSetup)) {
        Write-Host 'The bootstrapper could not be downloaded; setup relies on the runtime already being there.' -ForegroundColor Yellow
    }
}

if (Test-Path $webviewSetup) {
    Write-Host ''
    Write-Host '== Recompiling setup with the runtime bootstrapper' -ForegroundColor Cyan
    & $iscc "/DMyAppVersion=$version" (Join-Path $PSScriptRoot 'ToneArtStudio.iss')
    if ($LASTEXITCODE -ne 0) { throw 'ISCC failed to recompile the installer.' }
}

$setup = Get-ChildItem (Join-Path $root 'dist-installer\*.exe') -ErrorAction SilentlyContinue |
         Select-Object -First 1

if (-not $setup) { throw 'No installer was produced in dist-installer.' }

Write-Host ''
Write-Host ("== Built {0} - {1} MB" -f $setup.Name, [math]::Round($setup.Length / 1MB, 1))

# A public link means the installer can be handed over without a GitHub login;
# the release created by the workflow keeps it beyond the link's 72 hours.
$form = 'fileToUpload=@' + $setup.FullName
$url = curl.exe -sS --max-time 300 -F reqtype=fileupload -F time=72h -F $form https://litterbox.catbox.moe/resources/internals/api.php

Write-Host ('DOWNLOAD-URL: ' + $url)
Write-Host ('SHA256: ' + (Get-FileHash $setup.FullName -Algorithm SHA256).Hash)
