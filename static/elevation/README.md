# Elevation-Aware Battery & Grade Profile Strip (removable)

100% client-side route elevation & grade profiling module for the Tesla Supercharger Route Planner.

## Overview

When a route is planned, `ElevationModule` samples ~50 equidistant coordinates along the route polyline (`plan.geometry.coordinates` or `plan.stops` fallback) and queries the free, no-key **Open-Meteo Elevation API** directly from the browser:

- Endpoint: `https://api.open-meteo.com/v1/elevation?latitude=...&longitude=...`
- Supports up to 100 coordinates per GET request, CORS `*`, zero server cost.
- Includes a deterministic synthetic terrain fallback (`generateSyntheticElevations`) if the browser is offline or upstream is unreachable.

## Features

1. **Interactive SVG Area Profile**:
   - Plots route elevation in feet (`ft`) or meters (`m`) against distance (`mi`).
   - Plots Supercharger stops (`#1`, `#2`, etc., and cyan forced stops) directly on the ridge/valley curve.
   - Collapsible strip along the bottom of the map (`#elevationStrip`), styled to fit Desktop, `/mobile`, and `/tesla` (`body.car-shell`) viewports without colliding with bottom sheets.
2. **Map-Synced Scrubbing**:
   - Hovering, clicking, or dragging on the elevation chart highlights the corresponding coordinate on the Leaflet map with a live tooltip (`elev · % grade · distance`) and shows the active leg’s net energy delta.
3. **EV Elevation Energy Impact**:
   - Computes climbing penalty (`+kWh` for ascent: \( m g \Delta h / \eta_{\text{climb}} \)) vs. **Regenerative Braking recovery** (`−kWh` on descent: \( m g \Delta h \cdot \eta_{\text{regen}} \)) per leg and for the overall trip.
   - Displays Climb `+kWh`, Regen `−kWh`, and Net `±kWh · ±Wh/mi` delta badges in the strip header.

## Files

| Path | Role |
| --- | --- |
| `elevation-profile.js` | `window.ElevationModule` API, sampling, Open-Meteo fetch + fallback, physics math, SVG chart & Leaflet scrub marker |
| `elevation.css` | Responsive bottom strip styles for desktop, `/mobile`, and `/tesla` car-shell |
| `README.md` | This documentation |

## How to remove later

1. Delete `static/elevation/` entirely.
2. In `static/index.html`, remove the `<link rel="stylesheet" href="/elevation/elevation.css...">` and `<script src="/elevation/elevation-profile.js..."></script>` lines.
3. In `static/app.js`, remove the optional `ElevationModule` mount / `routePlanned` hook.
4. Remove `https://api.open-meteo.com` from `connect-src` in `server.py` if no longer needed.
5. Remove `tests/test_elevation.js`.
