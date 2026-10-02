FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --registry="$NPM_REGISTRY" \
    || npm ci --ignore-scripts --registry=https://registry.npmjs.org
COPY index.html *.json *.ts ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
RUN cp /etc/apt/sources.list.d/debian.sources /tmp/debian.sources \
    && sed -i 's|http://deb.debian.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list.d/debian.sources \
    && (apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
        || (cp /tmp/debian.sources /etc/apt/sources.list.d/debian.sources \
            && apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates)) \
    && rm -f /tmp/debian.sources && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server ./server
ENV HOST=0.0.0.0 PORT=8791 SQLITE_DB_PATH=/app/data/db/personal-dance-library.db MEDIA_ROOT=/app/data/media
EXPOSE 8791
CMD ["node", "server/index.mjs"]
