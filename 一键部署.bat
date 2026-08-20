@echo off
title 文游引擎 - 一键部署
cd /d "%~dp0"
set /p MSG=提交说明（直接回车默认"更新"）:
if "%MSG%"=="" set MSG=更新
git add -A || (echo git 暂存失败 & pause & exit /b 1)
git commit -m "%MSG%" || (echo 没有需要提交的改动 & pause & exit /b 0)
git push || (echo 推送失败，请检查网络后重试 & pause & exit /b 1)
echo.
echo 已推送，GitHub Actions 将自动构建并部署，约 1-2 分钟后生效：
echo https://1418731519shuer.github.io/shanjian-denghuo/
pause
