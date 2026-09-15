FROM node:20-bookworm-slim

# Perbarui npm ke v10.9.9 (versi npm 10.x paling stabil & selaras untuk Node.js 20 LTS)
RUN npm install --global npm@10.9.9

WORKDIR /app

# Build dependencies for native Node.js modules such as better-sqlite3
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 \
       make \
       g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production

# Phase 18: jalankan sebagai non-root. Image node menyediakan user `node` (uid/gid 1000).
# Hanya direktori runtime yang benar-benar ditulis aplikasi yang diberi kepemilikan,
# bukan chmod 777 dan bukan write access ke seluruh filesystem.
RUN mkdir -p /app/database /app/data /app/backups /app/logs \
             /app/public/uploads /app/auth_info_baileys \
    && chown -R node:node /app/database /app/data /app/backups /app/logs \
                          /app/public/uploads /app/auth_info_baileys \
    && chown node:node /app

USER node

EXPOSE 3001

CMD ["node", "app-customer.js"]
