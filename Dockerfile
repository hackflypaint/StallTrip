# Multi-stage build on Red Hat Hardened Images (HI).
# Builder has dnf/shell for assemble+verify; runtime is minimal (no shell/package manager).
# Catalog: https://images.redhat.com  |  Docs: Red Hat Hardened Images builder/runtime model
#
# Images are public (no Red Hat subscription required for HI pulls from registry.access.redhat.com).
# Base images are pinned by digest (tag kept for humans). Refresh digests when bumping HI.
# App version: keep LABEL / compose tag / server.APP_VERSION / VERSION in sync (v1.0.6).

ARG PYTHON_HI_VERSION=3.12
# Digests resolved 2026-10-27 via crane digest registry.access.redhat.com/hi/python:…
ARG PYTHON_HI_BUILDER_DIGEST=sha256:4616ad2ef27c0dd3238b3c2817281c367fe460b182c47607d6f65132b257aba9
ARG PYTHON_HI_RUNTIME_DIGEST=sha256:14ce8115a8eb67f602070b85bee19e22856a760454e74afed17a23d41cc1ddc2
ARG APP_VERSION=1.0.6

# ---------------------------------------------------------------------------
# Stage 1 — builder: stage app, byte-compile, import-check
# ---------------------------------------------------------------------------
FROM registry.access.redhat.com/hi/python:${PYTHON_HI_VERSION}-builder@${PYTHON_HI_BUILDER_DIGEST} AS builder

USER 0
WORKDIR /build

COPY routing.py server.py ./
COPY data/ ./data/
COPY static/ ./static/

# Stdlib-only app: no pip install. Compile + import smoke to fail the build early.
RUN ["python3", "-m", "compileall", "-q", "."]
RUN ["python3", "-c", "import routing; import server"]

# ---------------------------------------------------------------------------
# Stage 2 — runtime: minimal HI Python (no shell)
# ---------------------------------------------------------------------------
FROM registry.access.redhat.com/hi/python:${PYTHON_HI_VERSION}@${PYTHON_HI_RUNTIME_DIGEST}

ARG APP_VERSION=1.0.6

USER 0
WORKDIR /app

LABEL org.opencontainers.image.title="StallTrip" \
      org.opencontainers.image.description="Supercharger Route Planner" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.source="https://github.com/hackflypaint/StallTrip"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080 \
    COST_PROFILE=lean \
    APP_VERSION=${APP_VERSION}

COPY --from=builder --chown=65532:65532 /build/ /app/

USER 65532

EXPOSE 8080

# Exec-form only — HI runtime has no /bin/sh
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["python3", "-c", "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT','8080'), timeout=5)"]

ENTRYPOINT ["python3", "server.py"]
CMD ["8080"]
