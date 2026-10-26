# Tone Art Studio - desktop setup
#
# Installs the app if needed, then puts two icons on the Desktop:
#   Tone Art Studio  -> the installed app
#   Tone Art Remote  -> starts the tablet bridge
#
# Run it by double-clicking "Tone Art Studio Desktop Setup.cmd".

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exeName = 'Tone Art Studio.exe'
$installDir = Join-Path $env:ProgramFiles 'Tone Art Studio'
$installedExe = Join-Path $installDir $exeName
$desktop = [Environment]::GetFolderPath('Desktop')

function Write-Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "   $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "   $text" -ForegroundColor Yellow }

function Find-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    return $null
}

function New-Shortcut($path, $target, $workDir, $icon, $description) {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($path)
    $link.TargetPath = $target
    if ($workDir) { $link.WorkingDirectory = $workDir }
    if ($icon -and (Test-Path $icon)) { $link.IconLocation = "$icon,0" }
    if ($description) { $link.Description = $description }
    $link.Save()
}

Write-Host ''
Write-Host '  TONE ART STUDIO - DESKTOP SETUP' -ForegroundColor White
Write-Host '  Puts the app and the tablet remote on your Desktop.' -ForegroundColor DarkGray

# ---- 1. the app -----------------------------------------------------------
Write-Step '1 of 3  The app'

if (Test-Path $installedExe) {
    Write-Ok "Already installed: $installedExe"
}
else {
    $installer = Get-ChildItem -Path $root -Filter 'ToneArtStudioSetup-*.exe' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($null -eq $installer) {
        Write-Warn2 'ToneArtStudioSetup-*.exe is not next to this script.'
        Write-Warn2 "Download it, put it in this folder and run this again."
    }
    else {
        Write-Ok "Running $($installer.Name)"
        Write-Warn2 'SmartScreen may say "Windows protected your PC": click More info, then Run anyway.'
        Write-Warn2 'Accept the UAC prompt - the virtual audio driver needs it.'
        try {
            Start-Process -FilePath $installer.FullName -Wait
        }
        catch {
            Write-Warn2 "The installer could not start: $($_.Exception.Message)"
        }
        if (Test-Path $installedExe) { Write-Ok 'Installed.' }
        else {
            Write-Warn2 'The app still is not in Program Files - did the wizard finish?'
            Write-Warn2 'You can run the installer again later; the remote icon still works.'
        }
    }
}

# ---- 2. the remote --------------------------------------------------------
Write-Step '2 of 3  The tablet remote'

$node = Find-Node
if ($node) {
    Write-Ok "Node.js found: $node"
}
else {
    Write-Warn2 'The remote needs Node.js (free, about 30 MB) and it is not installed.'
    $answer = Read-Host '   Install it now with winget? [Y/n]'
    if ($answer -eq '' -or $answer -match '^(y|yes)$') {
        $winget = Get-Command winget -ErrorAction SilentlyContinue
        if ($winget) {
            Write-Ok 'Installing Node.js LTS - this takes a minute or two...'
            & winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements
        }
        else {
            Write-Warn2 'winget is not available on this PC.'
        }
        $node = Find-Node
        if ($node) { Write-Ok "Node.js installed: $node" }
        else {
            Write-Warn2 'Node.js is still missing. Opening the download page...'
            Start-Process 'https://nodejs.org/en/download'
            Write-Warn2 'Install the LTS version, then run this setup again.'
        }
    }
    else {
        Write-Warn2 'Skipped. The remote icon will ask again the first time you use it.'
    }
}

# ---- 3. the two desktop icons --------------------------------------------
Write-Step '3 of 3  Desktop icons'

$remoteCmd = Join-Path $root 'Tone Art Remote.cmd'
$appIconTarget = if (Test-Path $installedExe) { $installedExe } else { $null }

try {
    if ($appIconTarget) {
        $appLink = Join-Path $desktop 'Tone Art Studio.lnk'
        New-Shortcut -path $appLink -target $appIconTarget -workDir $installDir -icon $appIconTarget -description 'Tone Art Studio'
        Write-Ok 'Desktop: Tone Art Studio'
    }
    else {
        Write-Warn2 'No app icon yet - install the app first (step 1).'
    }

    if (Test-Path $remoteCmd) {
        $remoteLink = Join-Path $desktop 'Tone Art Remote.lnk'
        $icon = if ($appIconTarget) { $appIconTarget } else { (Join-Path $env:SystemRoot 'System32\shell32.dll') }
        New-Shortcut -path $remoteLink -target $remoteCmd -workDir $root -icon $icon -description 'Tablet remote for Tone Art Studio'
        Write-Ok 'Desktop: Tone Art Remote'
    }
    else {
        Write-Warn2 'Tone Art Remote.cmd is missing from this folder.'
    }
}
catch {
    Write-Warn2 "Could not create the shortcuts: $($_.Exception.Message)"
}

# ---- done ----------------------------------------------------------------
Write-Host ''
Write-Host '  DONE' -ForegroundColor White
Write-Host ''
Write-Host '  On the Desktop now:' -ForegroundColor Gray
Write-Host '    Tone Art Studio  - the app' -ForegroundColor Gray
Write-Host '    Tone Art Remote  - the tablet remote' -ForegroundColor Gray
Write-Host ''
Write-Host '  Using the remote:' -ForegroundColor Gray
Write-Host '    1. Open Tone Art Remote. Keep its window open.' -ForegroundColor Gray
Write-Host '    2. It prints an address like http://192.168.1.20:8787' -ForegroundColor Gray
Write-Host '    3. Type that into the tablet browser (same Wi-Fi).' -ForegroundColor Gray
Write-Host '    4. In the app, open "Tablet Remote" and press Connect.' -ForegroundColor Gray
Write-Host ''
Write-Host '  If the tablet cannot connect, allow Node.js through the' -ForegroundColor Gray
Write-Host '  Windows firewall for Private networks.' -ForegroundColor Gray
Write-Host ''
