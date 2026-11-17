# syntax=docker/dockerfile:1

FROM node:22-alpine AS frontend-build
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md /
RUN npm run build

FROM python:3.12-slim

WORKDIR /app

COPY backend/pyproject.toml backend/uv.lock LICENSE NOTICE THIRD_PARTY_NOTICES.md ./
RUN --mount=from=ghcr.io/astral-sh/uv:0.10.9,source=/uv,target=/bin/uv \
    uv sync --frozen --no-dev --no-cache

COPY backend/app ./app

COPY --from=frontend-build /frontend/dist ./app/static

ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers", "--no-access-log"]
