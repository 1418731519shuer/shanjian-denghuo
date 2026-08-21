@echo off
cd /d "%~dp0"
echo STEP1
netstat -ano | findstr /C:"127.0.0.1:8123" | findstr LISTENING >nul
echo STEP2 err=%errorlevel%
if %errorlevel%==0 (echo RUNNING) else (echo NOTRUN)
echo STEP3
pause
