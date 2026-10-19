# Live Highway Weather, Wind Headwind & Radar Overlay (removable)

100% client-side weather radar and route headwind/temperature efficiency module. Zero backend API calls.

## Features

1. **Live Animated Weather Radar Layer (RainViewer API)**
   - Queries `https://api.rainviewer.com/public/weather-maps.json` directly from the browser.
   - Integrates into the **Layers** menu (`#weatherSlot` inside `#layersPanel`) with a Show toggle, Play/Pause animation loop, frame scrubber, and opacity control.
   - Displays a compact floating **Radar Pill** (`#weatherRadarPill`) on the map with live frame timestamps and one-tap Play/Pause + Opacity cycle.

2. **Client-Side Route Weather & Headwind Efficiency Analysis (Open-Meteo API)**
   - Automatically triggers when a route is planned, querying `https://api.open-meteo.com/v1/forecast` for origin, Supercharger stops, and destination.
   - Computes compass bearing for each route leg and resolves meteorological wind into **Headwind**, **Tailwind**, and **Crosswind** vectors.
   - Calculates **Cold-Weather Battery Penalty** below 50°F (10°C) alongside aerodynamic wind impact.
   - Renders a **Route Weather & Wind Strip** (`#routeWeatherStrip`), a floating **Map Weather Pill** (`#mapWeatherPill`, e.g. `42°F (6°C) • 14 mph Headwind (-8% range)`), per-stop timeline weather badges, and map waypoint weather badges.

## Files

| Path | Role |
| --- | --- |
| `weather-overlay.js` | Module API (`window.WeatherModule`): RainViewer radar + Open-Meteo route wind/temp calculator |
| `weather.css` | Layers slot, radar pill, route weather strip, and responsive mobile/Tesla car-shell styles |
| `README.md` | Documentation and removal instructions |

## How to remove

1. Delete `static/weather/`.
2. Remove `<link rel="stylesheet" href="/weather/weather.css?v=car7">`, `<div id="weatherSlot"></div>`, and `<script src="/weather/weather-overlay.js?v=car7"></script>` from `static/index.html`.
3. Remove the optional `window.WeatherModule.mount(...)` hook in `static/app.js`.
