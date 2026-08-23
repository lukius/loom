# syntax=docker/dockerfile:1

# loom ships a static SPA, so there is no frontend build stage: the web
# assets are copied verbatim and served by FastAPI's StaticFiles mount.
FROM python:3.11-slim AS runtime

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    LOOM_HOST=0.0.0.0 \
    LOOM_PORT=8000

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# The server resolves `web/` and `samples/` relative to the parent of
# `src/`, so this layout has to mirror the repo's.
COPY src/ ./src/
COPY web/ ./web/
COPY samples/ ./samples/

RUN useradd -u 1000 -m -s /usr/sbin/nologin loom && chown -R loom:loom /app
USER loom

# `python loom.py` uses bare-package imports and must run from `src/`.
WORKDIR /app/src

EXPOSE 8000

CMD ["python", "loom.py"]
