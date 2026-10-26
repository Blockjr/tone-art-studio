<#
    CI entry point for the Windows installer.

    Produces the program a user downloads and runs:
    dist-installer\ToneArtStudioSetup-<version>.exe - a normal installed Windows
    app (start menu entry, desktop shortcut, uninstaller) that carries its own
    browser engine, so it does not depend on anything already being installed.

    The workflow that calls this stays deliberately tiny so the build logic lives
    in the repository with the rest of the project. The installed app is built
    first: it is the deliverable, and failing on it in two minutes is better than
    failing after the native host's nine-minute C++ pass.

    The native host, the Tone Art Gate VST3 and the virtual ASIO driver are still
    built afterwards into dist-native, next to the app rather than replacing it.

    Run it the same way locally if you want exactly what CI produces:

        powershell -ExecutionPolicy Bypass -File installer\ci-build.ps1
#>

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$iscc = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'

$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$buildDir = Join-Path $root 'native\build\HybridStudio_artefacts\Release'

# --------------------------------------------------------------------------
# 1. The installed application.
# --------------------------------------------------------------------------
Push-Location $root
try {
    Write-Host ''
    Write-Host '== Installing the build tools' -ForegroundColor Cyan
    npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }

    Write-Host ''
    Write-Host '== Building the interface' -ForegroundColor Cyan
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' }

    $index = Join-Path $root 'dist\index.html'
    if (-not (Test-Path $index)) { throw 'The interface build produced no dist\index.html.' }

    # A packaged app whose interface is missing is exactly the blank-window
    # failure this build exists to prevent, so it is checked before packaging.
    $scripts = Select-String -Path $index -Pattern 'src="(/assets/[^"]+\.js)"' -AllMatches
    if (-not $scripts) { throw 'dist\index.html does not reference a script bundle.' }
    $bundle = Join-Path $root ('dist' + ($scripts.Matches[0].Groups[1].Value -replace '/', '\'))
    if (-not (Test-Path $bundle)) { throw "The interface bundle $bundle is missing." }
    Write-Host ("   interface bundle: {0} ({1:N0} bytes)" -f (Split-Path -Leaf $bundle), (Get-Item $bundle).Length)

    Write-Host ''
    Write-Host '== Packaging the Windows app' -ForegroundColor Cyan
    npx electron-builder --win --x64 --publish never
    if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed.' }
}
finally {
    Pop-Location
}

$setup = Get-ChildItem (Join-Path $root 'dist-installer\*.exe') -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1

if (-not $setup) { throw 'No installer was produced in dist-installer.' }

$setupMb = [math]::Round($setup.Length / 1MB, 1)
Write-Host ''
Write-Host ("== Built {0} - {1} MB" -f $setup.Name, $setupMb) -ForegroundColor Green

# --------------------------------------------------------------------------
# 2. The native host, the VST3 and the virtual ASIO driver.
# --------------------------------------------------------------------------
if (Test-Path $iscc) {
    # The native host draws its interface with the WebView2 runtime, so its
    # installer carries Microsoft's bootstrapper for a PC that never had it.
    $webviewSetup = Join-Path $buildDir 'MicrosoftEdgeWebView2Setup.exe'
    if (-not (Test-Path $webviewSetup)) {
        New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
        $webviewUrl = 'https://go.microsoft.com/fwlink/p/?LinkId=' + '2124703'
        curl.exe -sSL --max-time 300 -o $webviewSetup $webviewUrl
    }

    Write-Host ''
    Write-Host '== Building the native host and its installer' -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot 'build-installer.ps1') -SkipUi
    if ($LASTEXITCODE -ne 0) { Write-Host 'The native host did not build; the installed app above is unaffected.' -ForegroundColor Yellow }
}
else {
    Write-Host ''
    Write-Host '== Inno Setup 6 is not on this machine; skipping the native host' -ForegroundColor Yellow
}

# A public link means the installer can be handed over without a GitHub login;
# the release created by the workflow keeps it beyond the link's 72 hours.
$form = 'fileToUpload=@' + $setup.FullName
$url = curl.exe -sS --max-time 300 -F reqtype=fileupload -F time=72h -F $form https://litterbox.catbox.moe/resources/internals/api.php

Write-Host ''
Write-Host ('DOWNLOAD-URL: ' + $url)
Write-Host ('SHA256: ' + (Get-FileHash $setup.FullName -Algorithm SHA256).Hash)
