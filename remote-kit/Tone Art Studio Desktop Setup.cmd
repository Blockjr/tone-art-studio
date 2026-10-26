@echo off
rem  Installs the app (if needed) and puts both icons on the Desktop.
rem  Double-click this file.
title Tone Art Studio - desktop setup
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
echo.
pause
