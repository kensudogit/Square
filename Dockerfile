# =============================================================================
# Square 決済アプリ — 単一コンテナ（API + ビルド済みフロント）
#
# フロントの fetch は "/api/..." の相対パスなので、Express から静的ファイルを
# 配信すれば同一オリジンになり、CORS もフロント側の設定変更も不要になる。
#
#   docker build -t square-payments .
#   docker run --rm -p 3000:3000 --env-file server/.env square-payments
#
# ★ 秘密情報はイメージに焼かない。実行時に環境変数で渡す。
#   必要な変数は server/.env.example を参照。
# =============================================================================

# ---- 1. フロントのビルド ----------------------------------------------------
FROM node:22-alpine AS web-build
WORKDIR /app/web

# 依存だけ先に入れてレイヤーキャッシュを効かせる
COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
# tsc --noEmit で型検査してから vite build（型エラーのままデプロイしない）
RUN npm run build


# ---- 2. サーバーのビルド ----------------------------------------------------
FROM node:22-alpine AS server-build
WORKDIR /app/server

COPY server/package.json server/package-lock.json ./
RUN npm ci

COPY server/ ./
RUN npm run build


# ---- 3. 実行イメージ --------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# 本番依存だけを入れる
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=server-build /app/server/dist ./dist

# ★ schema.sql は tsc の出力に含まれないので個別にコピーする。
#   これが無いと db:migrate / RUN_MIGRATIONS が実行時に落ちる
COPY server/src/db/schema.sql ./dist/db/schema.sql

# app.ts は dist/../public を静的配信の場所として解決する
COPY --from=web-build /app/web/dist ./public

# node ユーザー（uid 1000）は node イメージに最初から存在する
USER node

EXPOSE 3000

# alpine に curl は無いので node で叩く。
# /healthz は DB 接続まで確認するので、DB 断も検知できる
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
