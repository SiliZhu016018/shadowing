#!/bin/bash
# ============================================================
# 把 Whisper 模型（Xenova/whisper-tiny.en, ~75MB）托管到
# 你自己的 Cloudflare R2，供浏览器端 transformers.js 在国内 /
# 给朋友用时稳定加载（彻底绕开 HuggingFace CDN 被墙的问题）。
#
# 前置条件：
#   1) 装好并登录 wrangler：  npm i -g wrangler  &&  wrangler login
#   2) 已有一个 Cloudflare 账号（R2 免费额度足够个人/小圈子用）
#   3) 本机装了 Python3（用于 pip 装 huggingface_hub 下载工具）
#
# 用法：
#   chmod +x setup-whisper-models.sh
#   ./setup-whisper-models.sh
# 跑完把最后打印的 R2 公开地址填进 index.html 顶部 WHISPER_MODEL_HOST，再 git push。
# ============================================================
set -e

BUCKET=whisper-models
PREFIX="Xenova/whisper-tiny.en/resolve/main"

echo "① 建 R2 桶（如已存在会报 already exists，忽略即可）"
wrangler r2 bucket create "$BUCKET" || true

echo "② 开启公开访问（拿到 https://pub-xxxx.r2.dev 这类地址）"
wrangler r2 bucket public "$BUCKET" || true

echo "③ 设置 CORS：允许任意网站（含你 pages.dev / 自建域名）fetch 模型"
cat > /tmp/whisper-cors.json <<'EOF'
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 86400
  }
]
EOF
wrangler r2 bucket cors put "$BUCKET" --file /tmp/whisper-cors.json

echo "④ 经国内镜像(hf-mirror.com)下载 whisper-tiny.en 全部文件（服务端 curl，不受浏览器 CORS 限制）"
pip install -q huggingface_hub 2>/dev/null || true
rm -rf ./whisper-tiny.en
HF_ENDPOINT=https://hf-mirror.com hf download Xenova/whisper-tiny.en --local-dir ./whisper-tiny.en

echo "⑤ 上传到 R2（保留 transformers.js 需要的路径前缀 resolve/main）"
find ./whisper-tiny.en -type f | while read -r f; do
  rel="${f#./whisper-tiny.en/}"
  key="$PREFIX/$rel"
  echo "  -> $key"
  wrangler r2 object put "$BUCKET/$key" --file "$f"
done

echo ""
echo "✅ 完成！接下来两步："
echo "  1) 在 Cloudflare 控制台 R2 → $BUCKET → 设置 里复制「公开访问地址」"
echo "     （形如 https://pub-xxxx.r2.dev 或你绑定到自己域名的子域 https://models.你的域名.com）"
echo "  2) 把它填到 index.html 顶部的 WHISPER_MODEL_HOST = \"...\"，然后 git push。"
echo "     朋友打开网页点「生成材料」就会从你的 R2 拉模型，国内直连、不再失败。"
