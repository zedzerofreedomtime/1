@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ClipBot Flow Control Panel

call npm.cmd run web:build
if errorlevel 1 goto :error

start "" "http://127.0.0.1:8110"
call npm.cmd run control
exit /b %errorlevel%

:error
echo สร้าง Web App ไม่สำเร็จ กรุณารัน ติดตั้ง-ClipBot.bat ก่อน
pause
exit /b 1
