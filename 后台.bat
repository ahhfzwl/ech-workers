@echo off
title ech.exe - 后台静默运行
echo 正在以后台静默模式启动 ech.exe...
echo.

:: 使用 PowerShell 的 Start-Process -WindowStyle Hidden 来确保完全没有窗口
powershell -Command "Start-Process \"ech.exe\" -ArgumentList \"-f cf.wrap.eu.org:443\" -WindowStyle Hidden"

echo ech.exe 已在后台静默运行。
echo.
pause