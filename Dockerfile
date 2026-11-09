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

# The python base image lags Debian security updates by days, so upgrade the
# OS packages here rather than wait for it. The release build skips the layer
# cache, so every release re-runs this against the current archive.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
# The base image's pip vendors a stale CA bundle that still trusts distrusted
# roots. Install against the OS store instead, then drop the packaging tools:
# nothing needs them at runtime, and setuptools vendors packages with CVEs of
# its own. Use --cert, not --use-feature=truststore: pip 24.0 still honours its
# vendored bundle with truststore enabled.
RUN pip install --no-cache-dir --cert /etc/ssl/certs/ca-certificates.crt -r requirements.txt \
    && pip uninstall -y setuptools wheel pip

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
