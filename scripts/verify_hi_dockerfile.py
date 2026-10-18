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
    if "-builder AS builder" not in DOCKERFILE and "-builder as builder" not in DOCKERFILE.lower():
        fail("multi-stage builder stage missing")
    if "USER 65532" not in DOCKERFILE:
        fail("runtime must drop to UID 65532")
    if re.search(r"HEALTHCHECK.*\n.*CMD \[\"/bin/sh", DOCKERFILE):
        fail("HI runtime has no /bin/sh — healthcheck must be exec-form python")
    if "timeout=2" not in DOCKERFILE:
        fail("healthcheck urlopen must set timeout=2")
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
    print("verify_hi_dockerfile.py: OK")


if __name__ == "__main__":
    main()
