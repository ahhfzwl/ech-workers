@echo off
title ech.exe - 前台运行
echo 正在以前台模式启动 ech.exe...
echo.
ech -f cf.wrap.eu.org:443
echo.
echo 前台程序已退出。按任意键关闭窗口。
pause