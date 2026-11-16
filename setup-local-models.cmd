@echo off
cd /d "%~dp0"
py -3.12 platform\setup_models.py %*
if errorlevel 1 echo Setup needs installed Python 3.12. API-only use needs no setup.
pause
