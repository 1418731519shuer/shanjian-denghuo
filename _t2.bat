@echo off
setlocal enabledelayedexpansion
set /p A=第一个:
set KEY=
call :gk
echo KEY=[%KEY%]
pause
exit /b 0
:gk
set /p KEY=请输入key:
if not defined KEY ( echo 未输入 & exit /b 1 )
echo got %KEY%
exit /b 0
