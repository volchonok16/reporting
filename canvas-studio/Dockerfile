# Симметрика (canvas-studio) для встраивания в reporting.
# Сборка без npm-зависимостей: свой tools/build.mjs + Node 22.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY types ./types
COPY tools ./tools
COPY packages ./packages
COPY apps ./apps
COPY docs ./docs
RUN node --disable-warning=ExperimentalWarning tools/build.mjs

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    CS_HOST=0.0.0.0 \
    CS_PORT=8080 \
    CS_DATA=/data \
    CS_TRUST_PROXY=1 \
    CS_OPEN_REGISTRATION=0 \
    CS_FRAME_ANCESTORS="http://localhost:5173 http://127.0.0.1:5173"
COPY package.json tsconfig.json ./
COPY types ./types
COPY packages ./packages
COPY apps ./apps
COPY tools ./tools
COPY --from=build /app/dist ./dist
# pg — драйвер PostgreSQL для CS_DATABASE_URL (simmetrika_* в БД reporting).
RUN npm install --omit=dev pg@8.16.3 && mkdir -p /data
EXPOSE 8080
VOLUME ["/data"]
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/server/src/main.ts", "--host", "0.0.0.0", "--port", "8080"]
