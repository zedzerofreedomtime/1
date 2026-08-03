@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ติดตั้ง ClipBot Flow

echo [1/3] ติดตั้งส่วนที่จำเป็น...
call npm.cmd install --ignore-scripts
if errorlevel 1 goto :error

echo [2/3] สร้างหน้า Web App...
call npm.cmd run web:build
if errorlevel 1 goto :error

echo [3/3] เปิดหน้าติดตั้ง Extension และโฟลเดอร์ Extension...
start "" chrome.exe "chrome://extensions/"
start "" explorer.exe "%~dp0extension"

echo.
echo เปิด Developer mode แล้วกด Load unpacked จากนั้นเลือกโฟลเดอร์ extension
echo เมื่อเสร็จแล้ว ให้ดับเบิลคลิก เริ่ม-ClipBot.bat
pause
exit /b 0

:error
echo.
echo ติดตั้งไม่สำเร็จ กรุณาถ่ายภาพข้อความนี้ส่งมาให้ตรวจสอบ
pause
exit /b 1
