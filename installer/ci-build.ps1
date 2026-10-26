<#
    CI entry point for the Windows installer.

    Produces the program a user downloads and runs:
    dist-installer\ToneArtStudioSetup-<version>.exe - a normal installed Windows
    app (start menu entry, desktop shortcut, uninstaller) that carries its own
    browser engine, so it does not depend on anything already being installed.

    And, from the native pass below:

    dist-native\ToneArtStudioHostSetup-<version>.exe - the native engine: the
    same interface drawn by a JUCE host with ASIO input/output, VST3 hosting,
    and the Tone Art Virtual ASIO driver registered at install time.

    Both are published; they are different programs and neither replaces the
    other. The plain app cannot open ASIO - its audio runs in the browser
    engine - so the driver is only useful with the native host or another DAW.

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

Write-Host ''
Write-Host ('SHA256: ' + (Get-FileHash $setup.FullName -Algorithm SHA256).Hash)

# --------------------------------------------------------------------------
# 3. The native engine and the virtual ASIO driver.
#
# These are separate downloads from the app above: the app cannot use ASIO
# (its audio runs in the browser engine), while the native host can, and it is
# what registers the driver. The workflow publishes all of them, so there is
# nothing to upload from here - the point of this section is that a build which
# silently skipped the driver is visible in the log.
# --------------------------------------------------------------------------
$driverDll = Join-Path $buildDir 'HybridVirtualAsio.dll'
Write-Host ''
if (Test-Path $driverDll) {
    $dll = Get-Item $driverDll
    Write-Host ("== Virtual ASIO driver: {0} ({1:N0} bytes)" -f $dll.Name, $dll.Length) -ForegroundColor Green
    Write-Host ('SHA256: ' + (Get-FileHash $dll.FullName -Algorithm SHA256).Hash)

    # A driver that compiles is not yet a driver a DAW can open. Registering it
    # writes the two keys a host enumerates, so doing that here - and creating
    # the COM object once - is what turns 'it built' into evidence. Only an
    # elevated session can write HKLM; CI always is, and a local run that is not
    # gets the command to run by hand instead of a failure.
    $elevated = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)

    if ($elevated) {
        & (Join-Path $PSScriptRoot 'test-virtual-asio.ps1') -Dll $dll.FullName
        if ($LASTEXITCODE -ne 0 -or -not $?) {
            throw 'The virtual ASIO driver built but would not register.'
        }
    }
    else {
        Write-Host '== Not elevated, so the driver was not registered. To prove it works:' -ForegroundColor Yellow
        Write-Host ('   powershell -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'test-virtual-asio.ps1') + '"')
    }

    # Registering a device and playing audio through it are different claims. The
    # bridge between this DLL and the studio is the part a second DAW used to be
    # needed to test: the self-test *is* the second application, so it runs here
    # on every build, without admin rights and without a sound card.
    $selfTest = Join-Path $buildDir 'ToneArtVirtualAsioTest.exe'
    if (-not (Test-Path $selfTest)) {
        throw 'ToneArtVirtualAsioTest.exe was not built, so the driver-to-studio bridge went unverified.'
    }

    Write-Host ''
    Write-Host '== The virtual ASIO bridge (driver <-> studio)' -ForegroundColor Green
    & $selfTest
    if ($LASTEXITCODE -ne 0) {
        throw "The virtual ASIO bridge self-test failed (exit $LASTEXITCODE)."
    }
}
else {
    Write-Host '== WARNING: HybridVirtualAsio.dll was not built; the ASIO SDK headers are missing.' -ForegroundColor Yellow
    Write-Host '   Run: git -C native\build\_deps\juce-src submodule update --init --recursive, then configure again.' -ForegroundColor Yellow
}

$hostSetup = Get-ChildItem (Join-Path $root 'dist-native\*.exe') -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($hostSetup) {
    Write-Host ("== Native engine: {0} ({1:N0} bytes)" -f $hostSetup.Name, $hostSetup.Length) -ForegroundColor Green
    Write-Host ('SHA256: ' + (Get-FileHash $hostSetup.FullName -Algorithm SHA256).Hash)
}
else {
    Write-Host '== The native engine installer was not produced (Inno Setup missing or the native build failed).' -ForegroundColor Yellow
}
