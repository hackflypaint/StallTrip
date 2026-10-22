# Third-party data & media attribution

This repository’s **application code** is MIT-licensed (see [`LICENSE`](./LICENSE)).
Bundled **datasets and cached map images** come from upstream projects and are
**not** covered by that MIT grant. Operators and redistributors must respect
upstream terms. This file records what we know; it does **not** invent a license
where none was published.

---

## Supercharger station dataset — `data/superchargers.json`

| | |
| --- | --- |
| **Source** | [supercharge.info](https://supercharge.info/) community dataset |
| **Fetch API** | `https://supercharge.info/service/supercharge/allSites` |
| **Refresh** | `python3 scripts/fetch_superchargers.py` |
| **Data page** | https://supercharge.info/data |

### What we know about terms

- There is **no formal open-data license** published on the Supercharger dataset
  itself (as of this note). Site/forum Terms of Service apply to the website and
  **forum user contributions** (Creative Commons BY-NC-SA 3.0 for forum posts);
  that is **not** a clear license grant for the station JSON API.
- Community maintainers have stated publicly that the collected station data is
  intended for free use and that attribution is **appreciated but optional**
  (forum discussion: [Downloading supercharger data](https://forum.supercharge.info/t/downloading-supercharger-data/215)).
- The data is **not** provided or validated by Tesla Motors. Accuracy is not
  guaranteed; treat it as community-maintained.

### What users / redistributors should do

1. Credit **supercharge.info** when redistributing the bundled JSON or derivatives
   (recommended).
2. Re-check [supercharge.info](https://supercharge.info/) / forum guidance before
   commercial redistribution if terms change.
3. Do not present the dataset as official Tesla data.

---

## Fall foliage rasters — Explore Fall

| | |
| --- | --- |
| **Source** | [Explore Fall](https://www.explorefall.com/) daily foliage maps |
| **Live map** | https://www.explorefall.com/fall-foliage-map |
| **Daily PNG pattern** | `https://www.explorefall.com/maps/2026/{YYYYMMDD}.png` |
| **Cached copies** | `static/foliage/cache/*.png` (selected mid-October dates for offline demos) |
| **Module docs** | [`static/foliage/README.md`](./static/foliage/README.md) |

### What we know about terms

- Explore Fall publishes **open-access KML packages** in season and requires
  **credit** when maps derived from their products are shown. Official credit
  guidance (KML program):  
  https://www.explorefall.com/blog/2023/fall-foliage-kml  
  Summary of that guidance:
  - **All users:** a link to Explore Fall on webpages displaying their map data.
  - **Commercial:** verbal credit on live broadcast; otherwise credit + direct
    link to ExploreFall.com.
  - **Non-commercial:** credit + direct ExploreFall.com link in any medium.
- This app overlays the **same public daily PNG rasters** that power Explore
  Fall’s interactive map (CORS `Access-Control-Allow-Origin: *` observed on
  low-res PNGs). Explore Fall has not published a separate SPDX-style license
  text for those PNGs; treat the **KML attribution requirements** as the
  closest published terms and **always credit Explore Fall** in the UI.
- Cached PNGs under `static/foliage/cache/` are copies of those upstream daily
  rasters for offline demos; redistributing them inherits the same credit /
  upstream expectations.

### In-app credit

The foliage module shows an on-map credit linking to
[ExploreFall.com](https://www.explorefall.com/). Keep that credit if the overlay
is enabled.

---

## Other runtime third parties (not bundled)

These are loaded or called at runtime; not shipped as repo blobs:

| Dependency | Role | Notes |
| --- | --- | --- |
| Leaflet 1.9.4 (unpkg) | Map UI | BSD-2-Clause; loaded with SRI in `static/index.html` |
| Font Awesome 6.5.1 (cdnjs) | Icons | Font Awesome free license |
| OpenStreetMap / OpenTopoMap tiles | Basemap | Respect tile provider usage policies |
| FAA / NPS ArcGIS layers | Drone airspace | Public ArcGIS services |
| OSRM / Photon / Nominatim | Routing & geocode | Public instances; rate-limit responsibly |
| RainViewer / Open-Meteo | Weather overlays | Public APIs; see their terms |

---

## Questions

If upstream terms conflict with a planned distribution, prefer removing the
bundled asset (`data/superchargers.json` refresh from your own allowed source,
or delete `static/foliage/`) rather than guessing a license.
