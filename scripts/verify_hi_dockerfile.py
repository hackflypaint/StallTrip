#!/usr/bin/env python3
"""Static checks that Dockerfile / compose stay HI-compatible (no Docker daemon required)."""

from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
DOCKERFILE = (ROOT / "Dockerfile").read_text(encoding="utf-8")
COMPOSE = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")


def fail(msg: str) -> None:
    print(f"FAIL: {msg}")
    sys.exit(1)


def main() -> None:
    if "registry.access.redhat.com/hi/python:" not in DOCKERFILE:
        fail("must use Red Hat HI python image")
    if not re.search(r"-builder@\$\{PYTHON_HI_BUILDER_DIGEST\}\s+AS\s+builder", DOCKERFILE, flags=re.I):
        fail("multi-stage builder stage missing (digest-pinned FROM … AS builder)")
    # Pin builder + runtime by digest (not floating tag alone)
    if "PYTHON_HI_BUILDER_DIGEST" not in DOCKERFILE or "PYTHON_HI_RUNTIME_DIGEST" not in DOCKERFILE:
        fail("Dockerfile must declare PYTHON_HI_BUILDER_DIGEST and PYTHON_HI_RUNTIME_DIGEST")
    if "sha256:" not in DOCKERFILE:
        fail("digest ARG defaults must include sha256:… values")
    if not re.search(
        r"FROM registry\.access\.redhat\.com/hi/python:\$\{PYTHON_HI_VERSION\}-builder@\$\{PYTHON_HI_BUILDER_DIGEST\}",
        DOCKERFILE,
    ):
        fail("builder FROM must use PYTHON_HI_VERSION-builder@PYTHON_HI_BUILDER_DIGEST")
    if not re.search(
        r"FROM registry\.access\.redhat\.com/hi/python:\$\{PYTHON_HI_VERSION\}@\$\{PYTHON_HI_RUNTIME_DIGEST\}",
        DOCKERFILE,
    ):
        fail("runtime FROM must use PYTHON_HI_VERSION@PYTHON_HI_RUNTIME_DIGEST")
    if DOCKERFILE.count("USER 65532") < 2:
        fail("builder and runtime must both drop to UID 65532 (builder after chown)")
    if "COPY --chown=65532:65532" not in DOCKERFILE:
        fail("builder must COPY --chown=65532:65532 before USER 65532")
    builder_stage = DOCKERFILE.split("AS builder", 1)[1].split("FROM ", 1)[0]
    if "USER 65532" not in builder_stage:
        fail("builder stage must USER 65532 after chown")
    if builder_stage.find("COPY --chown=65532:65532") > builder_stage.find("USER 65532"):
        fail("builder must chown COPY before USER 65532")
    runtime_stage = DOCKERFILE.rsplit("FROM ", 1)[-1]
    if "USER 65532" not in runtime_stage:
        fail("runtime must drop to UID 65532")
    if re.search(r"HEALTHCHECK.*\n.*CMD \[\"/bin/sh", DOCKERFILE):
        fail("HI runtime has no /bin/sh — healthcheck must be exec-form python")
    if "timeout=5" not in DOCKERFILE:
        fail("healthcheck urlopen must set timeout=5")
    if "/health" not in DOCKERFILE or "os.environ.get('PORT'" not in DOCKERFILE:
        fail("HEALTHCHECK must probe /health using PORT env (default 8080)")
    if "/health" not in COMPOSE:
        fail("compose healthcheck must probe /health")
    if "ENTRYPOINT [\"python3\", \"server.py\"]" not in DOCKERFILE:
        fail("entrypoint must be exec-form python3 server.py")
    if re.search(r"^\s*RUN\b.*pip\s+install", DOCKERFILE, flags=re.I | re.M):
        fail("stdlib-only app must not pip install")
    if "no-new-privileges:true" not in COMPOSE:
        fail("compose missing no-new-privileges")
    if "cap_drop:" not in COMPOSE or "ALL" not in COMPOSE:
        fail("compose must cap_drop ALL")
    if "read_only: true" not in COMPOSE:
        fail("compose must be read_only")
    if "/tmp:size=" not in COMPOSE:
        fail("compose needs /tmp tmpfs for read_only runtime")
    if 'user: "65532:65532"' not in COMPOSE:
        fail("compose should pin user 65532 to match HI runtime")
    if "PYTHON_HI_VERSION" not in COMPOSE:
        fail("compose should pass PYTHON_HI_VERSION build arg")
    if "stalltrip:1.0.7" not in COMPOSE and 'image: stalltrip:' not in COMPOSE:
        fail("compose image must be stalltrip:<version> (not legacy local-dev names)")
    if "container_name: stalltrip" not in COMPOSE:
        fail("compose container_name must be stalltrip")
    if "org.opencontainers.image.version" not in DOCKERFILE:
        fail("Dockerfile should label org.opencontainers.image.version")
    if "127.0.0.1:8080:8080" not in COMPOSE:
        fail("compose should bind host port to 127.0.0.1:8080 (not 0.0.0.0)")
    if "BIND_ADDR" not in COMPOSE:
        fail("compose should document BIND_ADDR for in-container listen")
    print("verify_hi_dockerfile.py: OK")


if __name__ == "__main__":
    main()
