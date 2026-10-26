@echo off
rem ---------------------------------------------------------------------------
rem  Tone Art Studio - one-click Windows build
rem
rem  Double-click this file. It installs anything that is missing (Node.js,
rem  CMake, Inno Setup, the Visual Studio C++ tools), then compiles the app,
rem  the virtual ASIO driver, the Tone Art Gate VST3 and the setup .exe.
rem
rem  Expect the first run to take 20-40 minutes: the Visual Studio C++ tools
rem  are a large download. Later runs reuse everything and take a few minutes.
rem
rem  Progress is mirrored into build-log.txt next to this script.
rem ---------------------------------------------------------------------------

setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0.."
set "ROOT=%CD%"
set "LOG=%~dp0build-log.txt"

rem --- administrator rights (the Visual Studio tools and the installer want them)
net session >nul 2>&1
if errorlevel 1 (
    echo Requesting administrator rights...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

title Tone Art Studio - building the installer
echo.
echo ============================================================
echo   Tone Art Studio - one-click Windows build
echo ============================================================
echo   Folder : %ROOT%
echo   Log    : %LOG%
echo.

where winget >nul 2>&1
if errorlevel 1 (
    echo ERROR: winget was not found.
    echo.
    echo winget ships with the "App Installer" from the Microsoft Store.
    echo Install it, run Windows Update once, then double-click this file again:
    echo   https://apps.microsoft.com/detail/9nblggh4nns1
    echo.
    echo If you would rather install things by hand, see INSTALL.md.
    echo.
    pause
    exit /b 1
)

set "WINGET=winget install -e --silent --accept-package-agreements --accept-source-agreements"

rem ---------------------------------------------------------------- Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [1/4] Installing Node.js 20 LTS...
    %WINGET% --id OpenJS.NodeJS.LTS
    set "PATH=%PATH%;%ProgramFiles%\nodejs"
) else (
    echo [1/4] Node.js already installed.
)

rem ------------------------------------------------------------------ CMake
where cmake >nul 2>&1
if errorlevel 1 (
    echo [2/4] Installing CMake...
    %WINGET% --id Kitware.CMake
    set "PATH=%PATH%;%ProgramFiles%\CMake\bin"
) else (
    echo [2/4] CMake already installed.
)

rem -------------------------------------------------------------- Inno Setup
set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" (
    echo [3/4] Installing Inno Setup 6...
    %WINGET% --id JRSoftware.InnoSetup
) else (
    echo [3/4] Inno Setup already installed.
)

rem --------------------------------------------------- Visual Studio C++ tools
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "HAVE_VC="
if exist "%VSWHERE%" (
    for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "HAVE_VC=1"
)
if not defined HAVE_VC (
    echo [4/4] Installing the Visual Studio 2022 C++ build tools...
    echo       This is the long step: several GB, 10-30 minutes.
    %WINGET% --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
) else (
    echo [4/4] Visual Studio C++ tools already installed.
)

echo.
echo ============================================================
echo   Compiling the app, the ASIO driver, the VST3 and setup
echo ============================================================
echo.

if exist "%LOG%" del "%LOG%" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Transcript -Path '%LOG%' -Force | Out-Null } catch {}; & '%~dp0build-installer.ps1' -OpenOutput"

if errorlevel 1 (
    echo.
    echo ============================================================
    echo   THE BUILD FAILED
    echo ============================================================
    echo   The last error is above and is also saved in:
    echo     %LOG%
    echo   INSTALL.md has a troubleshooting table for each message the
    echo   build script can print.
    echo.
    pause
    exit /b 1
)

echo.
echo Finished. The setup program is in:
echo   %ROOT%\dist-installer\
echo.
pause
