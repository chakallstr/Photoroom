FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8000 \
    DATABASE_PATH=/data/photoroot.db
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts
# SQLite veritabanı kalıcı bir diskte durmalı; yoksa her yeniden başlatmada hesaplar silinir.
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8000/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
