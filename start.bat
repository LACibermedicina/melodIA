@echo off
cd /d "%~dp0"
node --disable-warning=ExperimentalWarning --env-file-if-exists=.env server.js
pause
