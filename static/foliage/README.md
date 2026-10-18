# Fall Foliage Module (removable)

Isolated Explore Fall daily foliage raster overlay + day slider.

## Source & attribution

- Daily CONUS PNGs from [Explore Fall](https://www.explorefall.com/fall-foliage-map)
  (`https://www.explorefall.com/maps/2026/{YYYYMMDD}.png`)
- Image bounds (lng/lat corners from Explore Fall’s map JS):
  `[-126,52] … [-65,23]` → Leaflet `[[23,-126],[52,-65]]`
- Explore Fall also publishes open-access KMLs (Mon/Thu in season) with required credit;
  this module uses their **public daily map rasters** (CORS `*`) which power the same
  interactive map, plus a small local cache under `cache/` for offline demos.
- **Required credit:** any UI showing this overlay must link to
  [ExploreFall.com](https://www.explorefall.com/).

## Files

| Path | Role |
| --- | --- |
| `foliage-overlay.js` | Module API: mount/unmount, slider, image overlay |
| `foliage.css` | Panel + slider styles |
| `cache/*.png` | Optional offline copies of selected dates |
| `README.md` | This file |

## How to remove later

1. Delete the folder `static/foliage/` entirely.
2. In `static/index.html`, remove:
   - `<link rel="stylesheet" href="/foliage/foliage.css">`
   - `<script src="/foliage/foliage-overlay.js"></script>`
   - the `#foliageSlot` element inside the layers panel (if present)
3. In `static/app.js`, remove the single optional hook:
   - `window.FoliageModule?.mount(...)` / `unmount` calls (search for `FoliageModule`)
4. Remove foliage mentions from `docs/app-guide.md` / Context guide.
5. Drop foliage assertions from `tests/verify_ui.js`.

No routing, charger, or Docker logic depends on this module.
