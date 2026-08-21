@echo off
title 文游引擎 - 一键生成剧本
cd /d "%~dp0"
setlocal enabledelayedexpansion
echo ==========================================
echo   一键生成剧本（AI 自动写剧 + 素材自动映射）
echo ==========================================
echo.
echo 选服务商（key 只需第一次输入，保存到本机 .keys 目录）：
echo   1. 智谱 GLM（推荐，glm-4-flash 免费，bigmodel.cn 注册即得）
echo   2. 阶跃星辰 step
echo   3. DeepSeek
echo   4. 月之暗面 Kimi
echo.
set /p PSEL=请选择 [1-4，默认1]:
if "%PSEL%"=="" set PSEL=1
set PROV=glm& set ENVN=ZHIPU_API_KEY& set SITE=bigmodel.cn
if "%PSEL%"=="2" ( set PROV=step& set ENVN=STEP_API_KEY& set SITE=platform.stepfun.com )
if "%PSEL%"=="3" ( set PROV=deepseek& set ENVN=DEEPSEEK_API_KEY& set SITE=platform.deepseek.com )
if "%PSEL%"=="4" ( set PROV=moonshot& set ENVN=MOONSHOT_API_KEY& set SITE=platform.moonshot.cn )
set KEY=
call :getkey %ENVN% %PROV% %SITE%
if not defined KEY ( pause & exit /b 1 )
rem 也支持命令行直传：一键生成剧本.bat "题材" 场景数
if "%~1"=="" ( set /p THEME=题材（如：修仙山门悬案）: ) else ( set "THEME=%~1" )
if "%THEME%"=="" ( echo 题材不能为空 & pause & exit /b 1 )
if "%~2"=="" ( set /p SCENES=场景数（3-8，默认5）: ) else ( set "SCENES=%~2" )
if "%SCENES%"=="" set SCENES=5
echo.
echo 生成《%THEME%》：%PROV%，%SCENES% 个场景，素材复用现有库...
python tools\autonovel.py "%THEME%" --scenes %SCENES% --provider %PROV% --key "%KEY%"
if errorlevel 1 ( echo. & echo 生成失败：若提示 402 说明该账户欠费，重跑并选 1 号智谱免费额度 & pause & exit /b 1 )
echo.
echo 完成！产物在 games_output\%THEME%\ ，双击其中 index.html 即玩。
pause
exit /b 0

:getkey
rem %1=环境变量名 %2=服务商id %3=官网
call set KEY=%%%1%%
if defined KEY exit /b 0
if exist ".keys\%2.txt" ( set /p KEY=<".keys\%2.txt" )
if defined KEY exit /b 0
echo.
echo 还没有 %2 的 API key。免费获取地址：%3
set /p KEY=请粘贴 API key（只保存到本机 .keys\%2.txt）:
if not defined KEY ( echo 未输入 key & exit /b 1 )
if not exist .keys mkdir .keys
echo %KEY%>".keys\%2.txt"
echo 已保存，下次不用再输。
exit /b 0
