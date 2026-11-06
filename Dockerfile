# Build do frontend (Angular) e do backend (TypeScript) em uma única imagem de execução
FROM node:22-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine AS backend
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install --no-audit --no-fund
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 STATIC_DIR=/app/public
WORKDIR /app/backend
COPY --from=backend /app/backend/dist ./dist
COPY --from=backend /app/backend/node_modules ./node_modules
COPY --from=backend /app/backend/migrations ./migrations
COPY --from=backend /app/backend/package.json ./
COPY --from=frontend /app/frontend/dist/axionyx/browser /app/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT:-3000}/api/health || exit 1
CMD ["node", "dist/server.js"]
