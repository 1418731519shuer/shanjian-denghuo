@echo off
title 文游引擎 - 一键玩
cd /d "%~dp0"
if not exist dist\index.html (
  echo dist 不存在，先构建...
  python tools\build.py
  if errorlevel 1 ( echo 构建失败，请先运行 一键安装依赖.bat & pause & exit /b 1 )
)
rem 已在运行的服务器不再重复启动
netstat -ano | findstr "LISTENING" | findstr "127.0.0.1:8123" >nul
if not errorlevel 1 (
  echo 服务器已在运行，直接打开浏览器...
  start "" http://127.0.0.1:8123
  pause
  exit /b 0
)
echo 启动本地服务器 http://127.0.0.1:8123 （关闭本窗口即停止）
start "" http://127.0.0.1:8123
python -m http.server 8123 --bind 127.0.0.1 -d dist
echo 服务器已停止。
pause
