# Playwright 1.56.1 + Chromium 等が入る公式イメージに合わせる
FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

# 依存関係をインストール
COPY package*.json ./
RUN npm ci
# ブラウザを確実にインストール（依存もまとめて）
RUN npx playwright install chromium --with-deps

# ソースコードをコピー
COPY . .

# 必要ならポート指定（デフォルト 8080 なら不要だが、明示しておくと安心）
ENV PORT=8080

# サーバ起動コマンド（index.mjs が Express サーバ）
CMD ["node", "index.mjs"]
