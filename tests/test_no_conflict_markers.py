#!/usr/bin/env python3
"""Guard against leftover git merge conflict markers in shipped sources."""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {".git", "__pycache__", "node_modules", ".venv", "venv"}
SCAN_SUFFIXES = {".py", ".js", ".css", ".html", ".yml", ".yaml", ".md", ".json", ".sh"}
MARKERS = ("<<<<<<<", ">>>>>>>")


class TestNoConflictMarkers(unittest.TestCase):
    def test_repo_has_no_git_conflict_markers(self):
        hits = []
        for path in ROOT.rglob("*"):
            if not path.is_file():
                continue
            if any(part in SKIP_DIRS for part in path.parts):
                continue
            if path.suffix.lower() not in SCAN_SUFFIXES and path.name not in {
                "Dockerfile",
                "VERSION",
                ".dockerignore",
                ".gitignore",
            }:
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for i, line in enumerate(text.splitlines(), 1):
                stripped = line.lstrip()
                if stripped.startswith("<<<<<<<") or stripped.startswith(">>>>>>>"):
                    hits.append(f"{path.relative_to(ROOT)}:{i}: {stripped[:80]}")
        self.assertEqual(hits, [], msg="git conflict markers present:\n" + "\n".join(hits))

    def test_server_module_imports(self):
        import server  # noqa: F401

        self.assertEqual(server.APP_VERSION, "1.0.7")


if __name__ == "__main__":
    unittest.main()
