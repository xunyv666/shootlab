#!/usr/bin/env bash
# 把 prototype/ 发布到 Cloudflare Pages 的 shootlab 项目
#
# 用法：bash tools/deploy.sh
#
# 首次使用需要先登录一次（浏览器点确认即可，之后凭据存在本机）：
#   wrangler login
#
# 为什么不是 push 自动部署：这个项目是 Direct Upload 模式创建的，
# Cloudflare 不支持把已存在的直传项目改成 Git 集成。要自动部署得另建项目。
set -e

cd "$(dirname "$0")/.."

if ! command -v wrangler >/dev/null 2>&1; then
  echo "找不到 wrangler，先装一下：npm i -g wrangler" >&2
  exit 1
fi

if ! wrangler whoami 2>/dev/null | grep -q "Account ID"; then
  echo "还没登录 Cloudflare，先跑：wrangler login" >&2
  exit 1
fi

echo "→ 发布 prototype/ 到项目 shootlab"
wrangler pages deploy prototype \
  --project-name shootlab \
  --branch main \
  --commit-dirty=true

echo
echo "线上地址：https://shootlab.pages.dev/"
