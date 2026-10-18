/**
 * Removable Fall Foliage module — Explore Fall daily CONUS raster overlay.
 *
 * Data: public daily PNGs from explorefall.com/maps/2026/{YYYYMMDD}.png
 * Bounds: MAP_IMAGE_COORDINATES from Explore Fall’s fall-foliage-map.js
 * Credit: https://www.explorefall.com/ (required)
 *
 * Mount into a layers-panel slot. Delete static/foliage/ to remove (see README).
 */
(function (global) {
  "use strict";

  const EF_YEAR = 2026;
  const EF_REMOTE = `https://www.explorefall.com/maps/${EF_YEAR}`;
  const EF_CACHE = "/foliage/cache";
  // Same corners Explore Fall uses (lng, lat) → Leaflet [[south,west],[north,east]]
  const IMAGE_BOUNDS = [
    [23, -126],
    [52, -65],
  ];
  const OVERLAY_OPACITY = 0.72;

  /** Cached dates shipped under foliage/cache/ (offline / demo fallback). */
  const CACHED_DATES = [
    "20261011", "20261012", "20261013", "20261014", "20261015",
    "20261016", "20261017", "20261018", "20261019", "20261020",
    "20261021", "20261022", "20261023", "20261024", "20261025",
  ];

  /** Full season index matching Explore Fall’s slider (Sep 1 – Dec 31). */
  function buildSeasonDates(year) {
    const out = [];
    const start = new Date(Date.UTC(year, 8, 1)); // Sep 1
    const end = new Date(Date.UTC(year, 11, 31));
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      const day = String(d.getUTCDate()).padStart(2, "0");
      out.push(`${y}${m}${day}`);
    }
    return out;
  }

  const SEASON_DATES = buildSeasonDates(EF_YEAR);

  function formatDateLabel(yyyymmdd) {
    const y = Number(yyyymmdd.slice(0, 4));
    const m = Number(yyyymmdd.slice(4, 6)) - 1;
    const d = Number(yyyymmdd.slice(6, 8));
    return new Date(y, m, d).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function defaultDateIndex() {
    const today = new Date();
    const key =
      `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}` +
      `${String(today.getDate()).padStart(2, "0")}`;
    const idx = SEASON_DATES.indexOf(key);
    if (idx >= 0) return idx;
    // Prefer mid-October demo window if outside season
    const mid = SEASON_DATES.indexOf("20261018");
    return mid >= 0 ? mid : Math.floor(SEASON_DATES.length / 2);
  }

  function imageUrlFor(dateKey) {
    if (CACHED_DATES.includes(dateKey)) {
      return `${EF_CACHE}/${dateKey}.png`;
    }
    return `${EF_REMOTE}/${dateKey}.png`;
  }

  const api = {
    _map: null,
    _overlay: null,
    _enabled: false,
    _dateIndex: defaultDateIndex(),
    _slotEl: null,
    _sliderBlock: null,
    _dateLabel: null,
    _slider: null,

    /**
     * @param {{ map: L.Map, slotEl: HTMLElement }} opts
     */
    mount(opts) {
      if (!opts || !opts.map || !opts.slotEl || typeof L === "undefined") return;
      this.unmount();
      this._map = opts.map;
      this._slotEl = opts.slotEl;
      this._dateIndex = defaultDateIndex();
      this._renderSlot();
    },

    unmount() {
      this._setEnabled(false);
      if (this._slotEl) this._slotEl.innerHTML = "";
      this._map = null;
      this._slotEl = null;
      this._sliderBlock = null;
      this._dateLabel = null;
      this._slider = null;
    },

    isEnabled() {
      return this._enabled;
    },

    getSelectedDate() {
      return SEASON_DATES[this._dateIndex];
    },

    _renderSlot() {
      const dateKey = SEASON_DATES[this._dateIndex];
      this._slotEl.innerHTML = `
        <div class="foliage-slot">
          <div class="foliage-slot-header">
            <div class="foliage-slot-title"><i class="fa-solid fa-leaf"></i> Fall Foliage</div>
            <label class="foliage-toggle">
              <input type="checkbox" id="foliageToggle" />
              Show
            </label>
          </div>
          <div class="foliage-slider-block" id="foliageSliderBlock">
            <div class="foliage-date-label" id="foliageDateLabel">${formatDateLabel(dateKey)}</div>
            <div class="foliage-date-sub">Scrub daily Explore Fall color estimates</div>
            <input
              type="range"
              class="foliage-day-slider"
              id="foliageDaySlider"
              min="0"
              max="${SEASON_DATES.length - 1}"
              value="${this._dateIndex}"
              aria-label="Fall foliage date"
            />
            <div class="foliage-legend-mini">
              <span><i class="foliage-swatch" style="background:#2f5c2e"></i>Little / None</span>
              <span><i class="foliage-swatch" style="background:#a8c256"></i>Low</span>
              <span><i class="foliage-swatch" style="background:#e8c547"></i>Moderate</span>
              <span><i class="foliage-swatch" style="background:#e8913a"></i>High</span>
              <span><i class="foliage-swatch" style="background:#c73e1d"></i>Peak</span>
              <span><i class="foliage-swatch" style="background:#6b4423"></i>Past Peak</span>
            </div>
            <div class="foliage-credit">
              Foliage map data ©
              <a href="https://www.explorefall.com/" target="_blank" rel="noopener">Explore Fall</a>
              — daily estimates for travel planning.
            </div>
          </div>
        </div>
      `;

      this._sliderBlock = this._slotEl.querySelector("#foliageSliderBlock");
      this._dateLabel = this._slotEl.querySelector("#foliageDateLabel");
      this._slider = this._slotEl.querySelector("#foliageDaySlider");
      const toggle = this._slotEl.querySelector("#foliageToggle");

      toggle.addEventListener("change", () => {
        this._setEnabled(toggle.checked);
      });

      this._slider.addEventListener("input", () => {
        this._dateIndex = Number(this._slider.value);
        this._updateDateLabel();
        if (this._enabled) this._applyOverlay();
      });
    },

    _updateDateLabel() {
      const key = SEASON_DATES[this._dateIndex];
      if (this._dateLabel) this._dateLabel.textContent = formatDateLabel(key);
    },

    _setEnabled(on) {
      this._enabled = !!on;
      if (this._sliderBlock) {
        this._sliderBlock.classList.toggle("is-active", this._enabled);
      }
      if (this._enabled) {
        this._applyOverlay();
      } else if (this._overlay && this._map) {
        this._map.removeLayer(this._overlay);
        this._overlay = null;
      }
    },

    _applyOverlay() {
      if (!this._map) return;
      const dateKey = SEASON_DATES[this._dateIndex];
      const url = imageUrlFor(dateKey);

      if (this._overlay) {
        this._overlay.setUrl(url);
        return;
      }

      this._overlay = L.imageOverlay(url, IMAGE_BOUNDS, {
        opacity: OVERLAY_OPACITY,
        interactive: false,
        className: "foliage-image-overlay",
        zIndex: 350,
      }).addTo(this._map);

      // If remote fails, fall back to nearest shipped cache tile
      const img = this._overlay.getElement && this._overlay.getElement();
      if (img) {
        img.addEventListener("error", () => {
          if (url.startsWith(EF_CACHE)) return;
          let fallback = null;
          if (CACHED_DATES.includes(dateKey)) {
            fallback = dateKey;
          } else if (CACHED_DATES.length) {
            fallback = CACHED_DATES.reduce((best, d) =>
              Math.abs(Number(d) - Number(dateKey)) <
              Math.abs(Number(best) - Number(dateKey))
                ? d
                : best
            );
          }
          if (fallback) this._overlay.setUrl(`${EF_CACHE}/${fallback}.png`);
        });
      }
    },
  };

  global.FoliageModule = api;
})(window);
