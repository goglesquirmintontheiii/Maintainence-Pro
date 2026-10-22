# Maintenance Pro — production image (self-hosted edition)
# Stage 1: build the web app
FROM node:20-bookworm-slim AS web
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
COPY frontend/scripts/ ./scripts/
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN mkdir -p ../mpro/static && npm run build

# Stage 2: Python app
FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy \
    MPRO_DATA_DIR=/data
COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock README.md LICENSE TRADEMARKS.md ./
RUN uv sync --frozen --no-dev --no-install-project --extra server
COPY mpro/ ./mpro/
COPY --from=web /src/mpro/static/app ./mpro/static/app
RUN uv sync --frozen --no-dev --extra server && useradd --system --uid 10001 mpro && mkdir -p /data && chown mpro /data
USER mpro
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz',timeout=4).status==200 else 1)"
CMD ["/app/.venv/bin/mpro", "serve", "--host", "0.0.0.0", "--port", "8080"]
