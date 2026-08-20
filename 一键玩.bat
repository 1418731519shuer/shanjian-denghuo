@echo off
title 文游引擎 - 一键玩
cd /d "%~dp0"
if not exist dist\index.html (
  echo [1/2] dist 不存在，先构建...
  python tools\build.py || (echo 构建失败，请先运行 一键安装依赖.bat & pause & exit /b 1)
)
echo 启动本地服务器 http://127.0.0.1:8123 ...
start "" http://127.0.0.1:8123
python -m http.server 8123 --bind 127.0.0.1 -d dist
echo 服务器已停止。
pause
