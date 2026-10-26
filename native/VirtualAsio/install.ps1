<#
    Registers (or removes) the Tone Art Virtual ASIO device.

    ASIO drivers are user-mode in-process COM servers, so this needs administrator
    rights to write HKLM, but no driver signing, no test mode and no reboot.

    Usage, from an elevated prompt or normally (UAC will prompt):
        powershell -ExecutionPolicy Bypass -File .\install.ps1
        powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
#>

param(
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$dll = Join-Path $PSScriptRoot "HybridVirtualAsio.dll"
$asioKey = "HKLM:\SOFTWARE\ASIO\Tone Art Virtual ASIO"

if (-not $Uninstall -and -not (Test-Path $dll)) {
    throw "HybridVirtualAsio.dll was not found next to this script ($dll). Build the HybridVirtualAsio target first."
}

$arguments = if ($Uninstall) { "/u /s `"$dll`"" } else { "/s `"$dll`"" }

Write-Host "Calling regsvr32 $arguments (elevating)..."
$process = Start-Process -FilePath "regsvr32.exe" -ArgumentList $arguments -Verb RunAs -Wait -PassThru

if ($process.ExitCode -ne 0) {
    throw "regsvr32 failed with exit code $($process.ExitCode). Check that the DLL is 64-bit and the build succeeded."
}

if ($Uninstall) {
    if (Test-Path $asioKey) { throw "The ASIO registry key still exists at $asioKey." }
    Write-Host "Removed: Tone Art Virtual ASIO is no longer registered."
} else {
    if (-not (Test-Path $asioKey)) { throw "regsvr32 succeeded but $asioKey is missing." }

    $entry = Get-ItemProperty $asioKey
    Write-Host "Registered: Tone Art Virtual ASIO"
    Write-Host "  CLSID      : $($entry.CLSID)"
    Write-Host "  Description: $($entry.Description)"
    Write-Host ""
    Write-Host "Restart any ASIO host, then pick 'Tone Art Virtual ASIO' as its device."
}
