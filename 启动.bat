@echo off
rem ===========================================================
rem  无限象棋项目 - 关闭并重启
rem
rem  双击运行即可。它会:
rem    1. 只结束这个项目自己的 node 进程。两条定位规则:
rem         - 命令行里带项目文件夹名的 node (也就是 nodemon)
rem         - 正在监听 3443 (本项目的开发 HTTPS 端口) 的 node
rem       都带 /T, 连子进程一起结束。上面那层 npm 会自己退出。
rem       故意不扫 3000, 那个端口太多别的开发工具在用。
rem    2. 等端口释放
rem    3. 用 npm run watch 重新启动 (它自己会先 build)
rem
rem  如果项目挪了地方或改了文件夹名, 下面两处都要改:
rem    PROJECT_DIR                = 项目完整路径
rem    powershell 那行里的 $marker = 项目文件夹名 (小写)
rem ===========================================================

setlocal
set "PROJECT_DIR=E:\youxi\xiangqi\infinitechess-2025.05.12"

title 无限象棋 - 重启中
echo ==========================================================
echo   重启项目: %PROJECT_DIR%
echo ==========================================================
echo.

if not exist "%PROJECT_DIR%\package.json" (
    echo [错误] 找不到 "%PROJECT_DIR%\package.json"
    echo        请用记事本打开本脚本, 把 PROJECT_DIR 改成正确的项目路径。
    echo.
    pause
    exit /b 1
)

echo [1/3] 关闭正在运行的项目进程...
powershell -NoProfile -Command "$marker='infinitechess-2025.05.12'; $hit=$false; foreach($q in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($marker) })){ $target=[int]$q.ProcessId; $hit=$true; Write-Host ('      project cmdline -> stopping PID ' + $target); taskkill /PID $target /T /F 2>&1 | Out-Null }; if($hit){ Start-Sleep -Seconds 1 }; foreach($c in @(Get-NetTCPConnection -LocalPort 3443 -State Listen -ErrorAction SilentlyContinue)){ $o=Get-CimInstance Win32_Process -Filter ('ProcessId='+$c.OwningProcess) -ErrorAction SilentlyContinue; if($o -and $o.Name -eq 'node.exe'){ $target=[int]$o.ProcessId; $hit=$true; Write-Host ('      port 3443 -> stopping PID ' + $target); taskkill /PID $target /T /F 2>&1 | Out-Null } }; if(-not $hit){ Write-Host '      Nothing running. Going straight to start.' }"
echo.

echo [2/3] 等待端口释放...
timeout /t 3 /nobreak >nul
echo.

echo [3/3] 启动中 (npm run watch, 它会先自动 build)...
echo       起来以后浏览器打开:  https://localhost:3443
echo       停止服务: 在这个窗口按 Ctrl+C
echo.
cd /d "%PROJECT_DIR%"
call npm run watch

echo.
echo ==========================================================
echo   服务已停止。按任意键关闭窗口。
echo ==========================================================
pause >nul
endlocal
