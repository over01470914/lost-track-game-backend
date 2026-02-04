#!/bin/bash

# 部署脚本
echo "=== 末日火车游戏网站部署脚本 ==="

# 1. 环境检查
if ! command -v node &> /dev/null; then
    echo "错误: Node.js 未安装"
    exit 1
fi

# 检查 PM2
if ! command -v pm2 &> /dev/null; then
    echo "正在安装 PM2..."
    npm install pm2 -g
fi

# 2. 安装依赖
echo "=== 正在安装/更新依赖 ==="
npm install

# 3. 启动/重启服务
echo "=== 正在启动 PM2 服务 ==="
# 尝试停止旧服务，防止端口占用，如果不存在也不报错
pm2 stop lost-track-backend 2>/dev/null || true
pm2 delete lost-track-backend 2>/dev/null || true

# 启动新服务
# --name 指定进程名称，方便管理
# server/index.js 是入口文件
pm2 start server/index.js --name "lost-track-backend"

# 4. 保存状态
pm2 save

echo ""
echo "=== 部署成功 ==="
echo "服务已在后台运行。可以使用 'pm2 logs lost-track-backend' 查看日志。"
echo "访问地址: https://dashboard.lost-track-game.com"