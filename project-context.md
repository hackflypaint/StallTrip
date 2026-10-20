# Project context

## App
Tesla Supercharger Route Planner — maximize Supercharger visits along a route, with map area force-include and Docker packaging (Red Hat HI multi-stage).

## Workflow
- Automated development and tests are the preferred path for contributors.
- Local checkout stays current with **git** (`clone` / `pull`).
- Never document personal absolute home paths. Prefer cloud/CI test runs unless you intentionally run suites locally.

## Repo
Public GitHub (or your fork) — work from `main`. Clone URL is whatever remote you configured (see README).

## Sync with git

```bash
git clone <repository-url> tesla-supercharger-planner
cd tesla-supercharger-planner
git checkout main
git pull --ff-only origin main
docker compose up -d --build
# → http://localhost:8080
```

Everyday update:

```bash
cd tesla-supercharger-planner
git pull --ff-only origin main
docker compose up -d --build
```

## Deliverables
- [README.md](./README.md) — short quick start
- [code-architecture.md](./code-architecture.md) — code summary, deep dive, packages, HI build
- [app-guide.md](./app-guide.md)
