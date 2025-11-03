@echo off
title ech.exe - 关闭后台进程
echo 正在尝试关闭所有名为 ech.exe 的后台进程...
echo.

:: 检查 ech.exe 是否正在运行
tasklist /fi "imagename eq ech.exe" 2>nul | find /i "ech.exe" >nul

if errorlevel 1 (
    echo 没有找到 ech.exe 进程在运行。
) else (
    :: 找到进程，执行强制关闭
    taskkill /f /im ech.exe
    if errorlevel 0 (
        echo 成功关闭所有 ech.exe 进程。
    ) else (
        echo 关闭进程失败，可能需要管理员权限。
    )
)

echo.
echo 按任意键退出窗口...
pause