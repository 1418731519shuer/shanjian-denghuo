@echo off
setlocal enabledelayedexpansion
title 文游引擎 - 一键测试
cd /d "%~dp0"
set PASS=0
set FAIL=0
set FAILED=
echo ========== lint_script 剧本门禁 ==========
python tools\lint_script.py
if errorlevel 1 (set /a FAIL+=1 & set "FAILED=!FAILED! lint_script") else (set /a PASS+=1)
for %%T in (e2e_test e2e_text_script e2e_editor e2e_display e2e_mobile e2e_sprite_check e2e_ai_gen_panel e2e_routes smoke_ai_gen) do (
  if exist tools\%%T.mjs (
    echo.
    echo ========== %%T ==========
    node tools\%%T.mjs
    if errorlevel 1 (set /a FAIL+=1 & set "FAILED=!FAILED! %%T") else (set /a PASS+=1)
  )
)
echo.
echo ========================================
echo 通过 %PASS% 套，失败 %FAIL% 套
if not "%FAILED%"=="" echo 失败项:%FAILED%
echo ========================================
endlocal
pause
