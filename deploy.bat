@echo off
chcp 65001 >nul
echo =========================================
echo 开始部署 xiapi 服务
echo =========================================
echo.

REM 1. 检查 Node.js 是否安装
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)

echo [1/6] Node.js 版本:
node -v
echo.

REM 2. 检查 PM2 是否安装
where pm2 >nul 2>nul
if %errorlevel% neq 0 (
    echo [2/6] 正在安装 PM2...
    npm install -g pm2
    npm install -g pm2-windows-startup
    pm2-startup install
) else (
    echo [2/6] PM2 已安装
)
echo.

REM 3. 安装依赖
echo [3/6] 正在安装项目依赖...
call npm install --production
if %errorlevel% neq 0 (
    echo [错误] 依赖安装失败
    pause
    exit /b 1
)
echo.

REM 4. 创建日志目录
echo [4/6] 创建日志目录...
if not exist "logs" mkdir logs
echo.

REM 5. 检查环境变量文件
echo [5/6] 检查环境变量配置...
if not exist ".env" (
    echo [警告] .env 文件不存在
    if exist ".env.example" (
        copy .env.example .env
        echo 已从 .env.example 创建 .env 文件
        echo 请编辑 .env 文件，配置必要的参数后重新运行此脚本
        notepad .env
        pause
        exit /b 1
    ) else (
        echo [错误] .env.example 文件也不存在
        pause
        exit /b 1
    )
)
echo.

REM 6. 启动服务
echo [6/6] 正在启动服务...
pm2 describe xiapi >nul 2>nul
if %errorlevel% equ 0 (
    echo 服务已存在，正在重启...
    pm2 reload ecosystem.config.js --update-env
) else (
    echo 首次启动服务...
    pm2 start ecosystem.config.js
)

REM 保存 PM2 配置
pm2 save

echo.
echo =========================================
echo 部署完成！
echo =========================================
echo.
echo 服务信息:
pm2 status
echo.
echo 常用命令:
echo   查看状态: pm2 status
echo   查看日志: pm2 logs xiapi
echo   重启服务: pm2 restart xiapi
echo   停止服务: pm2 stop xiapi
echo   删除服务: pm2 delete xiapi
echo.
pause
