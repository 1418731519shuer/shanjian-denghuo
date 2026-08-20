@echo off
title 文游引擎 - 一键构建
cd /d "%~dp0"
echo === 构建 dist（图片转 WebP + PWA 缓存清单）===
python tools\build.py || (echo 构建失败 & pause & exit /b 1)
echo.
echo === 校验资源引用 ===
pushd dist
python ..\tools\check_refs.py || (popd & echo 校验失败 & pause & exit /b 1)
popd
echo.
echo 构建完成，产物在 dist\ 目录。
pause
