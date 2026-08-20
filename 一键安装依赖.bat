@echo off
title 文游引擎 - 一键安装依赖
cd /d "%~dp0"
echo 检查 Python...
python --version || (echo 未找到 python，请先安装 Python 3.8+ 并加入 PATH & pause & exit /b 1)
echo 检查 Node...
node --version || (echo 未找到 node（测试需要），请安装 Node.js 18+ & pause)
echo 安装 Pillow（图片构建依赖）...
python -m pip install Pillow || (echo Pillow 安装失败 & pause & exit /b 1)
echo.
echo 依赖就绪。
pause
