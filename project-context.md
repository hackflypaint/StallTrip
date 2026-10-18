# Project context

## App
Tesla Supercharger Route Planner — maximize Supercharger visits along a route, with map area force-include and Docker packaging (Red Hat HI multi-stage).

## Workflow
- **Cloud** is the source of truth: all development and automated tests run there.
- **Local** checkout lives under `tesla-supercharger-planner` and stays current with **git** (`clone` / `pull`).
- Never document personal absolute home paths. Never run automated test suites on the local machine unless  asks.

## Repo
`<owner>/<repo>` — work from `main`.

## Sync with git

```bash
***REMOVED***
git clone <repository-url> tesla-supercharger-planner
cd tesla-supercharger-planner
git checkout main
git pull --ff-only origin main
docker compose up -d --build
# → http://localhost:8080
```

Everyday update:

```bash
***REMOVED***/tesla-supercharger-planner
git pull --ff-only origin main
docker compose up -d --build
```

## Deliverables
- [README.md](./README.md) — short quick start
- [code-architecture.md](./code-architecture.md) — code summary, deep dive, packages, HI build
- [app-guide.md](./app-guide.md)
