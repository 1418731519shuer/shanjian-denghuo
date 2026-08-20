@echo off
title 文游引擎 - 一键生成剧本
cd /d "%~dp0"
set /p THEME=请输入题材（如：修仙山门悬案）:
if "%THEME%"=="" (echo 题材不能为空 & pause & exit /b 1)
set /p SCENES=场景数（3-8，默认5）:
if "%SCENES%"=="" set SCENES=5
echo.
echo 开始生成《%THEME%》（%SCENES% 个场景，复用现有素材库）...
python tools\autonovel.py "%THEME%" --scenes %SCENES% || (echo 生成失败：请检查 API key（智谱 ZHIPU_API_KEY 或阶跃 STEP_API_KEY） & pause & exit /b 1)
echo.
echo 完成！产物在 games_output\%THEME%\ ，双击其中 index.html 即可玩。
pause
