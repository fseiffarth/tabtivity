@echo off
rem Launch Tabtivity in dev mode (Tauri + Vite hot reload).
rem Generated launcher used by the desktop shortcut.
cd /d "%~dp0.."
title Tabtivity (dev)
echo Starting Tabtivity in dev mode...
rem Not `npm run tauri:dev`: its pretauri:dev hook is a bash script that cmd cannot run.
call npx tauri dev --no-watch
if errorlevel 1 (
  echo.
  echo Tabtivity exited with an error. Press any key to close.
  pause >nul
)
