@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tabtivity-mcp.ps1" %*
exit /b %errorlevel%
