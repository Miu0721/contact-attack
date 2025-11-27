FROM node:20-slim

WORKDIR /app

# 依存関係
COPY package*.json ./
RUN npm ci

# ソース一式
COPY . .

# デフォルトの起動コマンド（index.mjs のサーバを起動）
CMD ["node", "index.mjs"]
