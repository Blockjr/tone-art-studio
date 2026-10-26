<#
    Registers the freshly built Tone Art Virtual ASIO driver, checks that what an
    ASIO host looks for is really there, then takes it out again.

    Building is not the same as registering. A DLL can link, export all four COM
    entry points and still fail on the way in: a wrong class id, a key written to
    the wrong registry view, an HKLM that is not writable. This is run by
    native-windows.yml on an elevated runner, before the driver is packaged, so a
    driver that cannot register never reaches a release.

    It asserts the two keys hosts read, that InprocServer32 points at the DLL that
    was just built, and that CoCreateInstance on the class id hands back a driver
    object - which is what a DAW does when it opens the device. Registration is
    undone at the end, so the machine is left as it was found.

    Run it by hand after a local native build:

        powershell -ExecutionPolicy Bypass -File installer\test-virtual-asio.ps1
#>

param(
    [string]$Dll = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not $Dll) {
    $Dll = Join-Path $root 'native\build\HybridStudio_artefacts\Release\HybridVirtualAsio.dll'
}

if (-not (Test-Path $Dll)) {
    throw "The driver was not built: $Dll is missing. Configure with -DHYBRID_BUILD_VIRTUAL_ASIO=ON first."
}

$Dll = (Resolve-Path $Dll).Path

# Must stay in step with native/VirtualAsio/VirtualAsioIds.h: a host finds the
# driver through this key, then creates it through this class id.
$clsid = '{6E1B7A52-2C4E-4B0E-9F1B-7A3C5D8E9F21}'
$asioKey = 'HKLM:\SOFTWARE\ASIO\Tone Art Virtual ASIO'
$comKey = "HKLM:\SOFTWARE\Classes\CLSID\$clsid\InprocServer32"

function Invoke-Regsvr32([string[]]$Arguments) {
    $process = Start-Process -FilePath regsvr32.exe -ArgumentList $Arguments -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw ("regsvr32 {0} exited {1}." -f ($Arguments -join ' '), $process.ExitCode)
    }
}

Write-Host "driver: $Dll ($((Get-Item $Dll).Length) bytes)"

Invoke-Regsvr32 @('/s', "`"$Dll`"")

foreach ($key in @($asioKey, $comKey)) {
    if (-not (Test-Path $key)) {
        throw "DllRegisterServer did not create $key."
    }
}

$asio = Get-ItemProperty $asioKey
if ($asio.CLSID -ne $clsid) {
    throw "The ASIO key points at '$($asio.CLSID)', not $clsid."
}

$server = (Get-ItemProperty $comKey).'(default)'
if ($server -ne $Dll) {
    throw "InprocServer32 is '$server', not '$Dll'."
}

Write-Host "ASIO key   : $asioKey"
Write-Host "Description: $($asio.Description)"
Write-Host "Server     : $server"

# The class factory has to hand out a driver for the exact class id an ASIO host
# passes in, so this is as close as a headless machine gets to opening the
# device in a DAW.
try {
    $type = [Type]::GetTypeFromCLSID([guid]$clsid)
    $driver = [Activator]::CreateInstance($type)
    Write-Host ("COM object : {0}" -f $driver.GetType().FullName)
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($driver)
}
catch {
    throw "CoCreateInstance on $clsid failed, so an ASIO host could not open the device: $($_.Exception.Message)"
}

Invoke-Regsvr32 @('/u', '/s', "`"$Dll`"")

if ((Test-Path $asioKey) -or (Test-Path $comKey)) {
    throw 'DllUnregisterServer left its keys behind.'
}

Write-Host 'Registration and unregistration both work.' -ForegroundColor Green
