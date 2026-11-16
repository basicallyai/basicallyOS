@echo off
cd /d "%~dp0"
node "%~dp0platform\start.mjs"
if errorlevel 1 pause
