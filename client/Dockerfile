FROM node:24-alpine AS base

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Dev stage for local development (used by compose.yml)
FROM base AS dev
EXPOSE 5173
CMD ["npm", "run", "dev"]

# Production build stage: builds static assets
FROM base AS builder
ARG VITE_API_BASE=/api
ARG VITE_GATEWAY_WS=""
ARG VITE_IDLE_THRESHOLD_MS="120000"
ENV VITE_API_BASE=$VITE_API_BASE
ENV VITE_GATEWAY_WS=$VITE_GATEWAY_WS
ENV VITE_IDLE_THRESHOLD_MS=$VITE_IDLE_THRESHOLD_MS
RUN npm run build

# Production runtime stage: serves static bundle via minimal nginx
FROM nginx:alpine AS prod
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
