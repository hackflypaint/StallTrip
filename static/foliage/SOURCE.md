# Explore Fall data source notes

Inspected `https://www.explorefall.com/fall-foliage-map` (network + `js/fall-foliage-map.js`):

- Daily rasters: `/maps/2026/{YYYYMMDD}.png` (low-res) and `/maps/2026-highres/{YYYYMMDD}.png`
- CORS: `Access-Control-Allow-Origin: *` on low-res PNGs
- Image corners (lng/lat): `[-126,52], [-65,52], [-65,23], [-126,23]`
- Season slider dates: 2026-09-01 … 2026-12-31
- Open KML program (credit required): https://www.explorefall.com/blog/2023/fall-foliage-kml  
  Public Drive sample folder currently holds PNG map packages, not live season KMLs;  
  daily PNGs above are what the interactive map actually overlays.

Cached copies of 2026-10-11 … 2026-10-25 live in `cache/` for offline demos.
