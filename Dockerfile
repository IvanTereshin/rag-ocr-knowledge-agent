FROM node:24-alpine AS web-build

WORKDIR /app/apps/web
COPY apps/web/package*.json ./
RUN npm ci
COPY apps/web ./
RUN npm run build

FROM node:24-alpine AS api-build

WORKDIR /app/apps/api
COPY apps/api/package*.json ./
RUN npm ci
COPY apps/api ./
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-alpine

WORKDIR /app/apps/api

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV WEB_DIST_DIR=/app/apps/web/dist

COPY --from=api-build /app/apps/api/package*.json ./
COPY --from=api-build /app/apps/api/node_modules ./node_modules
COPY --from=api-build /app/apps/api/dist ./dist
COPY --from=web-build /app/apps/web/dist /app/apps/web/dist

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "dist/server.js"]
