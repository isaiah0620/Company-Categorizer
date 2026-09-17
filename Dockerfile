# syntax=docker/dockerfile:1

# ---- Build stage: compile TypeScript, including devDependencies ----
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage: production deps + compiled JS only ----
FROM node:20-slim
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# Run as a non-root user
RUN useradd --create-home --shell /bin/bash appuser \
    && chown -R appuser:appuser /app
USER appuser

# This image is meant to be run as a Cloud Run JOB, not a Service:
# each execution processes one batch and exits (see src/index.ts --once).
# Cloud Scheduler is what decides how often that happens (see deploy/).
CMD ["node", "dist/index.js", "--once"]
