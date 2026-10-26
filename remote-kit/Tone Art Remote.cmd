@echo off
rem  Tone Art Remote - starts the bridge that the tablet connects to.
rem  Keep this window open while you use the tablet; closing it stops the remote.
title Tone Art Remote - keep this window open
cd /d "%~dp0Remote"

set "NODE="
for %%I in (node.exe) do if not defined NODE set "NODE=%%~$PATH:I"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE (
  echo.
  echo   The tablet remote needs Node.js and it is not installed yet.
  echo.
  echo   Run "Tone Art Studio Desktop Setup.cmd" once - it installs Node.js
  echo   for you - or get the LTS version from https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "server\remote.mjs" (
  echo.
  echo   This shortcut cannot find the Remote folder.
  echo   Keep it next to the folder it came in, or run
  echo   "Tone Art Studio Desktop Setup.cmd" again to remake the icon.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting the Tone Art Studio bridge...
echo   Your browser opens the controller in a moment; the tablet uses the
echo   address printed below. Leave this window open.
echo.

start "" /b cmd /c "timeout /t 3 >nul & start http://localhost:8787"
"%NODE%" server\remote.mjs

echo.
echo   The bridge has stopped. The tablet cannot reach the studio now.
pause
