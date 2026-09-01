@echo off
rem ===========================================================
rem  无限象棋项目 - 关闭、重启，并自动打开浏览器
rem
rem  双击运行即可。做四件事:
rem    1. 只杀掉这个项目自己的 node 进程。两种定位方式:
rem         - 命令行里带项目文件夹名的 node (也就是 nodemon)
rem         - 正在监听 3443 (本项目的开发 HTTPS 端口) 的 node
rem       带上 /T, 把子进程一起带走，否则我们杀了 npm 它自己不退。
rem       故意不扫 3000, 那个端口太容易被别的软件占用。
rem    2. 等端口释放
rem    3. 后台预约一次浏览器打开: 它会一直等到 %PORT% 真的开始监听才打开。
rem       不能固定等几秒就打 —— npm run watch 会先 build, 首次往往要几十秒，
rem       打早了只会得到一个“无法访问”的页面。
rem    4. 用 npm run watch 起服务器 (它自己会先 build)
rem
rem  项目挑了地方的话，只需改下面这几个变量, 加上 kill 那行的 $marker:
rem    PROJECT_DIR   = 项目绝对路径
rem    PORT / URL    = 开发服务器的端口和网址
rem    WAIT_SECONDS  = 最多等多久再放弃打开浏览器
rem    $marker       = 项目文件夹名 (小写)
rem ===========================================================

setlocal
set "PROJECT_DIR=E:\youxi\xiangqi\infinitechess-2025.05.12"
set "PORT=3443"
set "URL=https://localhost:%PORT%"
set "WAIT_SECONDS=240"

title 无限象棋 - 重启中
echo ==========================================================
echo   项目目录: %PROJECT_DIR%
echo   网址：    %URL%
echo ==========================================================
echo.

if not exist "%PROJECT_DIR%\package.json" (
    echo [错误] 找不到 "%PROJECT_DIR%\package.json"
    echo        请用记事本打开本脚本, 把 PROJECT_DIR 改成正确的项目路径。
    echo.
    pause
    exit /b 1
)

echo [1/4] 关闭已在运行的项目进程...
powershell -NoProfile -Command "$marker='infinitechess-2025.05.12'; $hit=$false; foreach($q in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($marker) })){ $target=[int]$q.ProcessId; $hit=$true; Write-Host ('      project cmdline -> stopping PID ' + $target); taskkill /PID $target /T /F 2>&1 | Out-Null }; if($hit){ Start-Sleep -Seconds 1 }; foreach($c in @(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue)){ $o=Get-CimInstance Win32_Process -Filter ('ProcessId='+$c.OwningProcess) -ErrorAction SilentlyContinue; if($o -and $o.Name -eq 'node.exe'){ $target=[int]$o.ProcessId; $hit=$true; Write-Host ('      port %PORT% -> stopping PID ' + $target); taskkill /PID $target /T /F 2>&1 | Out-Null } }; if(-not $hit){ Write-Host '      Nothing running. Going straight to start.' }"
echo.

echo [2/4] 等待端口释放...
timeout /t 3 /nobreak >nul
echo.

echo [3/4] 预约浏览器: 服务器一开始监听 %PORT% 就自动打开 %URL%
echo       (最多等 %WAIT_SECONDS% 秒。自己已经打开了的话，关掉多出来的那个页就行。)
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "$deadline=(Get-Date).AddSeconds(%WAIT_SECONDS%); while((Get-Date) -lt $deadline){ $up=[bool](Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue); if($up){ Start-Sleep -Milliseconds 1500; Start-Process '%URL%'; exit }; Start-Sleep -Milliseconds 700 }"
echo.

echo [4/4] 启动中 (npm run watch, 它会先自动 build)...
echo       首次 build 要几十秒，浏览器会在 build 完、服务器起来之后自己弹出来。
echo       自签证书的安全警告直接选“继续访问”即可。
echo       停止服务: 在这个窗口里按 Ctrl+C
echo.
cd /d "%PROJECT_DIR%"
call npm run watch

echo.
echo ==========================================================
echo   服务已停止。按任意键关闭窗口。
echo ==========================================================
pause >nul
endlocal
