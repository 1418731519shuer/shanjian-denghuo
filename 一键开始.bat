@echo off
title 文游引擎 - 开始菜单
cd /d "%~dp0"
:menu
cls
echo ==========================================
echo        文游引擎 · 一键开始菜单
echo ==========================================
echo   1. 一键玩（本地构建+开浏览器）
echo   2. 一键生成剧本（AI 写剧，题材自定义）
echo   3. 一键构建（图片转 WebP，出 dist）
echo   4. 一键测试（全部自动化测试）
echo   5. 一键部署（推送上线，手机可玩）
echo   6. 一键安装依赖（首次使用先跑这个）
echo   7. 打开线上版（手机/电脑浏览器直接玩）
echo   0. 退出
echo ==========================================
set /p C=请选择:
if "%C%"=="1" ( call 一键玩.bat & goto menu )
if "%C%"=="2" ( call 一键生成剧本.bat & goto menu )
if "%C%"=="3" ( call 一键构建.bat & goto menu )
if "%C%"=="4" ( call 一键测试.bat & goto menu )
if "%C%"=="5" ( call 一键部署.bat & goto menu )
if "%C%"=="6" ( call 一键安装依赖.bat & goto menu )
if "%C%"=="7" ( start "" https://1418731519shuer.github.io/shanjian-denghuo/ & goto menu )
if "%C%"=="0" exit /b 0
goto menu
