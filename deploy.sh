#!/bin/bash

# xiapi 部署脚本
# 使用方法: bash deploy.sh

set -e

echo "========================================="
echo "开始部署 xiapi 服务"
echo "========================================="

# 1. 拉取最新代码（如果使用 git）
if [ -d ".git" ]; then
  echo "正在拉取最新代码..."
  git pull
fi

# 2. 安装依赖
echo "正在安装依赖..."
npm install --production

# 3. 创建日志目录
echo "创建日志目录..."
mkdir -p logs

# 4. 检查环境变量文件
if [ ! -f ".env" ]; then
  echo "警告: .env 文件不存在，请从 .env.example 复制并配置"
  echo "执行: cp .env.example .env"
  exit 1
fi

# 5. 使用 PM2 启动/重启服务
echo "正在启动服务..."
if pm2 describe xiapi > /dev/null 2>&1; then
  echo "服务已存在，正在重启..."
  pm2 reload ecosystem.config.js --update-env
else
  echo "首次启动服务..."
  pm2 start ecosystem.config.js
fi

# 6. 保存 PM2 配置（开机自启）
pm2 save

echo "========================================="
echo "部署完成！"
echo "========================================="
echo ""
echo "常用命令："
echo "  查看状态: pm2 status"
echo "  查看日志: pm2 logs xiapi"
echo "  重启服务: pm2 restart xiapi"
echo "  停止服务: pm2 stop xiapi"
echo "  删除服务: pm2 delete xiapi"
echo ""
