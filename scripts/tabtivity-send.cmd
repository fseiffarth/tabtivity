@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tabtivity-send.ps1" %*
exit /b %errorlevel%
