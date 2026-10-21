# Multi-stage build on Red Hat Hardened Images (HI).
# Builder has dnf/shell for assemble+verify; runtime is minimal (no shell/package manager).
# Catalog: https://images.redhat.com  |  Docs: Red Hat Hardened Images builder/runtime model
#
# Images are public (no Red Hat subscription required for HI pulls from registry.access.redhat.com).

ARG PYTHON_HI_VERSION=3.12

# ---------------------------------------------------------------------------
# Stage 1 — builder: stage app, byte-compile, import-check
# ---------------------------------------------------------------------------
FROM registry.access.redhat.com/hi/python:${PYTHON_HI_VERSION}-builder AS builder

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
FROM registry.access.redhat.com/hi/python:${PYTHON_HI_VERSION}

USER 0
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080 \
    COST_PROFILE=lean

COPY --from=builder --chown=65532:65532 /build/ /app/

USER 65532

EXPOSE 8080

# Exec-form only — HI runtime has no /bin/sh
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["python3", "-c", "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT','8080'), timeout=5)"]

ENTRYPOINT ["python3", "server.py"]
CMD ["8080"]
