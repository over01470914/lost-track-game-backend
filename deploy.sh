#!/bin/bash

# 部署脚本

echo "=== 末日火车游戏网站部署脚本 ==="
echo ""

# 检查Node.js是否安装
if ! command -v node &> /dev/null; then
    echo "错误: Node.js 未安装，请先安装 Node.js 14+"
    exit 1
fi

# 检查npm是否安装
if ! command -v npm &> /dev/null; then
    echo "错误: npm 未安装，请先安装 npm"
    exit 1
fi

# 检查MongoDB是否安装
if ! command -v mongod &> /dev/null; then
    echo "警告: MongoDB 未安装，请先安装 MongoDB"
    echo "否则打点功能将无法正常工作"
fi

echo ""
echo "=== 安装项目依赖 ==="
npm install

echo ""
echo "=== 启动服务 ==="
echo "请在浏览器中访问 https://dashboard.lost-track-game.com"
echo ""

# 启动服务
pm2 start npm
pm2 startup && pm2 save