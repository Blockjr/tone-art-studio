<#
    Builds Tone Art Studio for Windows and wraps it in an installer.

    Run from anywhere on Windows:

        powershell -ExecutionPolicy Bypass -File installer\build-installer.ps1

    Options:
        -SkipUi       reuse an existing dist/ instead of rebuilding the web UI
        -SkipNative   reuse an existing native/build instead of recompiling
        -OpenOutput   open the folder with the finished installer

    Requirements: Node.js 22.12+, Visual Studio 2022 with Desktop C++,
    CMake 3.25+, and Inno Setup 6.3+ (https://jrsoftware.org/isdl.php).
#>

param(
    [switch]$SkipUi,
    [switch]$SkipNative,
    [switch]$OpenOutput
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $root 'native\build\HybridStudio_artefacts\Release'
$outputDir = Join-Path $root 'dist-installer'
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version

function Write-Step([string]$text) {
    Write-Host ""
    Write-Host "== $text" -ForegroundColor Cyan
}

function Require-Command([string]$name, [string]$hint) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        throw "$name was not found on PATH. $hint"
    }
}

if (-not $SkipUi) {
    Write-Step "Building the web UI"
    Require-Command npm 'Install Node.js 22.12 or newer.'
    Push-Location $root
    try {
        npm ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
        npm run build
        if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' }
    }
    finally {
        Pop-Location
    }
}

if (-not $SkipNative) {
    Write-Step "Configuring the native host"
    Require-Command cmake 'Install CMake 3.25+ and the Visual Studio C++ workload.'
    Require-Command git 'Install Git for Windows: JUCE and the ASIO SDK are cloned with it.'

    $nativeDir = Join-Path $root 'native'
    $nativeBuild = Join-Path $nativeDir 'build'

    # JUCE's NEEDS_WEBVIEW2 links against the static WebView2 loader from the
    # Microsoft.Web.WebView2 NuGet package. Without it the configure step stops
    # with "Could NOT find WebView2". Fetch the package straight from NuGet and
    # point JUCE at it, so a clean machine needs no NuGet setup by hand.
    $webviewDir = Join-Path $root 'native\webview2'
    $webviewPkg = Join-Path $webviewDir 'Microsoft.Web.WebView2'
    $webviewHeader = Join-Path $webviewPkg 'build\native\include\WebView2.h'
    $script:webviewArgs = @()
    if (-not (Test-Path $webviewHeader)) {
        Write-Step "Fetching the WebView2 SDK"
        New-Item -ItemType Directory -Force -Path $webviewDir | Out-Null
        # Expand-Archive only accepts a .zip extension; a .nupkg is a zip.
        $nupkg = Join-Path $webviewDir 'webview2.zip'
        try {
            Invoke-WebRequest -Uri 'https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.3485.44' -OutFile $nupkg -UseBasicParsing
            Expand-Archive -Path $nupkg -DestinationPath $webviewPkg -Force
            Remove-Item $nupkg -Force -ErrorAction SilentlyContinue
        }
        catch {
            Write-Warning "The WebView2 SDK could not be downloaded: $($_.Exception.Message)"
        }
    }
    if (Test-Path $webviewHeader) {
        $script:webviewArgs = @("-DJUCE_WEBVIEW2_PACKAGE_LOCATION=$webviewDir")
    }
    else {
        Write-Warning 'The WebView2 SDK is missing; JUCE will stop at Configure because NEEDS_WEBVIEW2 cannot link.'
    }

    # JUCE and the ASIO SDK are cloned before configuring. FetchContent would
    # clone JUCE without its submodules, which leaves the virtual ASIO driver
    # without headers and needs a second configure pass; cloning it here, with
    # submodules, lets FetchContent reuse that copy in one pass.
    $juceDir = Join-Path $nativeDir 'third_party\JUCE'
    $juceTag = '9.0.4'
    if (-not (Test-Path (Join-Path $juceDir 'CMakeLists.txt'))) {
        Write-Step "Cloning JUCE $juceTag"
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $juceDir) | Out-Null
        git clone -q --depth 1 --branch $juceTag https://github.com/juce-framework/JUCE.git $juceDir
        if ($LASTEXITCODE -ne 0) { throw "Cloning JUCE $juceTag failed." }
    }

    # JUCE 8 keeps the Steinberg ASIO SDK in a submodule; JUCE 9 vendors it in
    # modules/juce_audio_devices/native/asio. Updating submodules is therefore
    # best effort: a repository without .gitmodules answers with nothing to do.
    Write-Step "Fetching the Steinberg ASIO SDK (JUCE submodule, if any)"
    git -C $juceDir submodule update --init --recursive
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'No ASIO submodule was fetched; JUCE 9 ships the SDK inside the repository, so this is expected.'
    }

    $juceArgs = @("-DFETCHCONTENT_SOURCE_DIR_JUCE=$juceDir")

    $generators = @()
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if ($vswhere -and (Test-Path $vswhere)) {
        $vsLine = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property catalog_productLineVersion) -join ''
        $vsLine = $vsLine.Trim()
        if ($vsLine) { Write-Host "Visual Studio $vsLine detected." }
        switch ($vsLine) {
            '2026' { $generators += ,@('-G', 'Visual Studio 18 2026', '-A', 'x64') }
            '2022' { $generators += ,@('-G', 'Visual Studio 17 2022', '-A', 'x64') }
            '2019' { $generators += ,@('-G', 'Visual Studio 16 2019', '-A', 'x64') }
        }
    }
    $generators += ,@()

    $baseArgs = @('-S', $nativeDir, '-B', $nativeBuild, '-DHYBRID_BUILD_VIRTUAL_ASIO=ON') + $script:webviewArgs + $juceArgs
    $configureLog = Join-Path $nativeBuild 'configure.log'
    $configured = $false
    $attempt = 0

    foreach ($extra in $generators) {
        $attempt++
        $label = if ($extra.Count -gt 1) { "generator '$($extra[1])'" } else { 'the CMake default generator' }
        Write-Host "Configure attempt $attempt with $label."
        if ($attempt -gt 1 -and (Test-Path $nativeBuild)) {
            Remove-Item -Recurse -Force $nativeBuild -ErrorAction SilentlyContinue
        }
        New-Item -ItemType Directory -Force -Path $nativeBuild | Out-Null

        $configureOutput = & cmake @baseArgs @extra 2>&1
        $code = $LASTEXITCODE
        $configureOutput | Out-String | Set-Content -Path $configureLog -Encoding utf8 -ErrorAction SilentlyContinue
        $configureOutput | ForEach-Object { Write-Host $_ }
        Write-Host "Configure attempt $attempt exited with code $code."
        if ($code -eq 0) { $configured = $true; break }

        Write-Host '--- last 25 lines of the configure output ---'
        Get-Content $configureLog -Tail 25 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
    }

    if (-not $configured) { throw "The CMake configure failed on every generator. Full log: $configureLog" }

    Write-Step "Compiling (Release)"
    # HYBRID_QUIET_BUILD keeps CI logs small enough to read whole: MSBuild then
    # prints errors only instead of one line per translation unit.
    $buildExtra = @()
    if ($env:HYBRID_QUIET_BUILD -eq '1') { $buildExtra = @('--', '/clp:ErrorsOnly') }
    cmake --build $nativeBuild --config Release --parallel @buildExtra
    if ($LASTEXITCODE -ne 0) { throw 'The native build failed.' }
}

$exe = Join-Path $buildDir 'Tone Art Studio.exe'
if (-not (Test-Path $exe)) {
    throw "Tone Art Studio.exe was not produced at $exe. Run without -SkipNative."
}

$dll = Join-Path $buildDir 'HybridVirtualAsio.dll'
if (-not (Test-Path $dll)) {
    Write-Warning 'HybridVirtualAsio.dll is missing; the installer will skip the driver.'
}

# WebView2 draws the interface. Fetch Microsoft's bootstrapper so setup can
# install the runtime on a PC that never received it; without this file setup
# still completes and the app explains what is missing instead of showing a
# blank window.
$webviewSetup = Join-Path $buildDir 'MicrosoftEdgeWebView2Setup.exe'
if (-not (Test-Path $webviewSetup)) {
    Write-Step 'Fetching the Microsoft WebView2 bootstrapper'
    $webviewUrl = 'https://go.microsoft.com/fwlink/p/?LinkId=' + '2124703'
    curl.exe -sSL --max-time 300 -o $webviewSetup $webviewUrl

    if (-not (Test-Path $webviewSetup)) {
        Write-Warning 'The WebView2 bootstrapper could not be downloaded; setup still works and the app explains what is missing.'
    }
}

Write-Step "Compiling the installer"
# Both locations are optional: ${env:ProgramFiles(x86)} is unset on 32-bit
# Windows and LOCALAPPDATA is unset in some service contexts, so test each one
# before joining a path onto it.
$isccCandidates = @()
foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
    if ($base) { $isccCandidates += (Join-Path $base 'Inno Setup 6\ISCC.exe') }
}
if ($env:LOCALAPPDATA) {
    $isccCandidates += (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
}
$isccCandidates = @($isccCandidates | Where-Object { Test-Path $_ })

if ($isccCandidates.Count -eq 0) {
    throw 'Inno Setup 6 was not found. Install it from https://jrsoftware.org/isdl.php (6.3 or newer).'
}

$iscc = $isccCandidates | Select-Object -First 1
& $iscc "/DMyAppVersion=$version" (Join-Path $PSScriptRoot 'ToneArtStudio.iss')
if ($LASTEXITCODE -ne 0) { throw 'ISCC failed to compile the installer.' }

$setup = Join-Path $outputDir "ToneArtStudioSetup-$version.exe"
if (-not (Test-Path $setup)) { throw "The installer was not written to $setup." }

$sizeMb = [math]::Round((Get-Item $setup).Length / 1MB, 1)
Write-Step "Done"
Write-Host "Installer : $setup ($sizeMb MB)" -ForegroundColor Green
Write-Host "Version   : $version"
Write-Host "Artefacts : $buildDir"

if ($OpenOutput) {
    Start-Process explorer.exe $outputDir
}
