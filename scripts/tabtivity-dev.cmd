@echo off
rem Launch Tabtivity in dev mode (Tauri + Vite hot reload).
rem Generated launcher used by the desktop shortcut.
cd /d "%~dp0.."
title Tabtivity (dev)
echo Starting Tabtivity in dev mode...
call npm run tauri:dev
if errorlevel 1 (
  echo.
  echo Tabtivity exited with an error. Press any key to close.
  pause >nul
)
