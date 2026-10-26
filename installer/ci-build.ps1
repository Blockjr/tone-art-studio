<#
    CI entry point for the Windows installer.

    The workflow that calls this stays deliberately tiny so the build logic lives
    in the repository with the rest of the project, not in YAML: this script
    guarantees Inno Setup, runs installer\build-installer.ps1, then uploads the
    finished setup program and prints a public download link.

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
