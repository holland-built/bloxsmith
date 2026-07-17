@echo off
REM Bloxsmith updater (Windows) — double-click to pull the newest image and restart.
cd /d "%~dp0"
docker compose pull && docker compose up -d
pause
