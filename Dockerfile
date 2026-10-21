# Build context = repo root. Deploys the long-running API (Railway / Render).
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --workspace=@nft-mint-bot/server --include-workspace-root --omit=dev

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --workspace=@nft-mint-bot/server --include-workspace-root
COPY server ./server
RUN npm run build --workspace=@nft-mint-bot/server

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=4000
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY server/package.json ./server/
COPY package.json ./
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
