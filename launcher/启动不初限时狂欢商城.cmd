@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

cd /d "C:\Users\华为mate14\WorkBuddy\2026-08-24-15-09-30\clearance-shop"

:: 连接云端 Supabase，让本地后台也能看到手机端订单
set "SUPABASE_URL=https://pzhblcoszvkbnmolkkxf.supabase.co"
set "SUPABASE_ANON_KEY=sb_publishable_AT0jjmkKEHk3PJThm9aG1w_q2hSfV4y"
set "NODE_PATH=C:\Users\华为mate14\.workbuddy\binaries\node\workspace\node_modules"

:: 如果服务已在运行，直接打开浏览器
netstat -ano | findstr ":4100" >nul 2>&1
if %errorlevel% == 0 (
    start "" "http://localhost:4100/"
    exit
)

:: 检查 node 是否存在
if not exist "C:\Users\华为mate14\.workbuddy\binaries\node\versions\22.22.2\node.exe" (
    echo [错误] 找不到 node.exe，请检查安装路径。
    pause
    exit
)

:: 启动 Node 服务（最小化窗口）
start /min "不初商城服务" "C:\Users\华为mate14\.workbuddy\binaries\node\versions\22.22.2\node.exe" server.js

:: 等待服务启动，最多 10 秒
set /a count=0
:wait_loop
timeout /t 1 /nobreak >nul
netstat -ano | findstr ":4100" >nul 2>&1
if %errorlevel% == 0 goto open_browser
set /a count+=1
if %count% lss 10 goto wait_loop

echo [错误] 商城服务启动失败，可能是端口被占用或权限不足。
echo 请右键以"管理员身份运行"此快捷方式再试一次。
pause
exit

:open_browser
start "" "http://localhost:4100/"
exit
