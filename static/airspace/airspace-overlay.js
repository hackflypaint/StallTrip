/**
 * Removable Airspace / UAS overlay — FAA ArcGIS FeatureServer GeoJSON.
 *
 * Sources (FAA AIS / UDDS, org ssFJjBXIUyZDrSYZ):
 *   Class_Airspace, Special_Use_Airspace, FAA_UAS_FacilityMap_Data,
 *   Stadiums, US_Airport
 * Viewport-bounded queries only; see README.md for URLs + removal.
 *
 * Visual language loosely evokes Autopylot-style UAS maps (rings + SUA
 * fills + UASFM ceiling cells) without calling Autopylot APIs.
 */
(function (global) {
  "use strict";

  const FAA_ORG =
    "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services";

  /** Min map zoom before any FAA fetch (avoid loading half of CONUS). */
  const MIN_ZOOM = 7;
  /** UAS Facility Map cells are dense — only at closer zooms. */
  const MIN_ZOOM_UASFM = 9;
  /** Airport / stadium markers. */
  const MIN_ZOOM_POINTS = 8;

  const DEBOUNCE_MS = 350;
  const BBOX_PAD_DEG = 0.08;
  const MAX_CLASS = 800;
  const MAX_SUA = 500;
  const MAX_UASFM = 1500;
  const MAX_POINTS = 200;

  const LAYERS = {
    classAirspace: {
      path: "Class_Airspace/FeatureServer/0",
      where: "CLASS IN ('B','C','D')",
      outFields: "NAME,CLASS,TYPE_CODE,LOWER_VAL,UPPER_VAL,LOWER_DESC,UPPER_DESC",
      max: MAX_CLASS,
      minZoom: MIN_ZOOM,
    },
    sua: {
      path: "Special_Use_Airspace/FeatureServer/0",
      where: "1=1",
      outFields: "NAME,TYPE_CODE,CLASS,LOWER_VAL,UPPER_VAL,LOWER_DESC,UPPER_DESC,STATE",
      max: MAX_SUA,
      minZoom: MIN_ZOOM,
    },
    uasfm: {
      path: "FAA_UAS_FacilityMap_Data/FeatureServer/0",
      where: "1=1",
      outFields: "CEILING,UNIT,APT1_FAAID,APT1_NAME,APT1_ICAO",
      max: MAX_UASFM,
      minZoom: MIN_ZOOM_UASFM,
    },
    stadiums: {
      path: "Stadiums/FeatureServer/0",
      where: "1=1",
      outFields: "NAME,CITY,STATE",
      max: MAX_POINTS,
      minZoom: MIN_ZOOM_POINTS,
    },
    airports: {
      path: "US_Airport/FeatureServer/0",
      where: "PRIVATEUSE=0 AND OPERSTATUS='OPERATIONAL'",
      outFields: "IDENT,NAME,ICAO_ID,TYPE_CODE,STATE",
      max: MAX_POINTS,
      minZoom: MIN_ZOOM_POINTS,
    },
  };

  function classStyle(klass) {
    const k = String(klass || "").toUpperCase();
    if (k === "B") {
      return {
        color: "#9b6bff",
        weight: 2,
        opacity: 0.85,
        fillColor: "#7a4fd6",
        fillOpacity: 0.12,
        dashArray: null,
      };
    }
    if (k === "C") {
      return {
        color: "#c4a8ff",
        weight: 1.75,
        opacity: 0.8,
        fillColor: "#8f7ab8",
        fillOpacity: 0.1,
        dashArray: "4 3",
      };
    }
    // D (and fallback)
    return {
      color: "#a8b0c0",
      weight: 1.5,
      opacity: 0.75,
      fillColor: "#6e7585",
      fillOpacity: 0.08,
      dashArray: "3 4",
    };
  }

  function suaStyle(typeCode) {
    const t = String(typeCode || "").toUpperCase();
    if (t === "P") {
      return {
        color: "#e85d5d",
        weight: 1.5,
        opacity: 0.9,
        fillColor: "#c0392b",
        fillOpacity: 0.28,
      };
    }
    if (t === "R") {
      return {
        color: "#3d8bfd",
        weight: 1.25,
        opacity: 0.85,
        fillColor: "#2a6fd6",
        fillOpacity: 0.22,
      };
    }
    if (t === "W") {
      return {
        color: "#5dade2",
        weight: 1.25,
        opacity: 0.85,
        fillColor: "#3498db",
        fillOpacity: 0.2,
      };
    }
    if (t === "MOA") {
      return {
        color: "#c9a227",
        weight: 1,
        opacity: 0.7,
        fillColor: "#b8860b",
        fillOpacity: 0.12,
        dashArray: "5 4",
      };
    }
    // A, AA, alert, etc.
    return {
      color: "#7f8c9a",
      weight: 1,
      opacity: 0.65,
      fillColor: "#5d6d7e",
      fillOpacity: 0.1,
    };
  }

  /** UAS Facility Map ceiling → Autopylot-like purple/grey wash. */
  function uasfmStyle(ceiling) {
    const c = Number(ceiling);
    if (!Number.isFinite(c) || c <= 0) {
      return {
        color: "#5a2d7a",
        weight: 0.4,
        opacity: 0.55,
        fillColor: "#4a1f66",
        fillOpacity: 0.45,
      };
    }
    if (c <= 100) {
      return {
        color: "#6b3d8f",
        weight: 0.35,
        opacity: 0.5,
        fillColor: "#6b3d8f",
        fillOpacity: 0.38,
      };
    }
    if (c <= 200) {
      return {
        color: "#7d5a9e",
        weight: 0.3,
        opacity: 0.45,
        fillColor: "#8060a0",
        fillOpacity: 0.28,
      };
    }
    if (c <= 300) {
      return {
        color: "#8a8fa3",
        weight: 0.25,
        opacity: 0.4,
        fillColor: "#9aa0b0",
        fillOpacity: 0.18,
      };
    }
    // 350–400 ft — light tint
    return {
      color: "#a8b0c0",
      weight: 0.2,
      opacity: 0.3,
      fillColor: "#c5cad6",
      fillOpacity: 0.08,
    };
  }

  function buildQueryUrl(layerDef, bboxStr) {
    const params = new URLSearchParams({
      where: layerDef.where,
      geometry: bboxStr,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: layerDef.outFields,
      returnGeometry: "true",
      outSR: "4326",
      f: "geojson",
      resultRecordCount: String(layerDef.max),
    });
    return `${FAA_ORG}/${layerDef.path}/query?${params.toString()}`;
  }

  function paddedBbox(bounds) {
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const pad = BBOX_PAD_DEG;
    const west = Math.max(-180, sw.lng - pad);
    const south = Math.max(-90, sw.lat - pad);
    const east = Math.min(180, ne.lng + pad);
    const north = Math.min(90, ne.lat + pad);
    // ArcGIS envelope: xmin,ymin,xmax,ymax
    return `${west},${south},${east},${north}`;
  }

  function popupHtml(title, rows) {
    const body = rows
      .filter(([, v]) => v != null && v !== "")
      .map(
        ([k, v]) =>
          `<div class="airspace-popup-row"><span>${k}</span><strong>${v}</strong></div>`
      )
      .join("");
    return `<div class="airspace-popup"><div class="airspace-popup-title">${title}</div>${body}</div>`;
  }

  const api = {
    _map: null,
    _slotEl: null,
    _enabled: false,
    _group: null,
    _layers: {
      class: null,
      sua: null,
      uasfm: null,
      points: null,
    },
    _abort: null,
    _debounceTimer: null,
    _onMoveEnd: null,
    _statusEl: null,
    _fetchSeq: 0,

    // Exported for unit tests
    _test: {
      classStyle,
      suaStyle,
      uasfmStyle,
      buildQueryUrl,
      LAYERS,
      FAA_ORG,
      MIN_ZOOM,
      MIN_ZOOM_UASFM,
    },

    /**
     * @param {{ map: L.Map, slotEl: HTMLElement }} opts
     */
    mount(opts) {
      if (!opts || !opts.map || !opts.slotEl || typeof L === "undefined") return;
      this.unmount();
      this._map = opts.map;
      this._slotEl = opts.slotEl;
      this._renderSlot();
    },

    unmount() {
      this._setEnabled(false);
      if (this._slotEl) this._slotEl.innerHTML = "";
      this._map = null;
      this._slotEl = null;
      this._statusEl = null;
      this._group = null;
      this._layers = { class: null, sua: null, uasfm: null, points: null };
    },

    isEnabled() {
      return this._enabled;
    },

    _renderSlot() {
      this._slotEl.innerHTML = `
        <div class="airspace-slot">
          <div class="airspace-slot-header">
            <div class="airspace-slot-title"><i class="fa-solid fa-plane"></i> Airspace / UAS</div>
            <label class="airspace-toggle">
              <input type="checkbox" id="airspaceToggle" />
              Show
            </label>
          </div>
          <div class="airspace-detail-block" id="airspaceDetailBlock">
            <div class="airspace-legend-mini">
              <span><i class="airspace-swatch airspace-swatch-b"></i>Class B</span>
              <span><i class="airspace-swatch airspace-swatch-c"></i>Class C</span>
              <span><i class="airspace-swatch airspace-swatch-d"></i>Class D</span>
              <span><i class="airspace-swatch airspace-swatch-r"></i>Restricted / Warning</span>
              <span><i class="airspace-swatch airspace-swatch-p"></i>Prohibited</span>
              <span><i class="airspace-swatch airspace-swatch-uas"></i>UASFM ceilings</span>
            </div>
            <div class="airspace-status" id="airspaceStatus">Zoom in (≥${MIN_ZOOM}) for FAA overlays</div>
            <div class="airspace-credit">
              Airspace data
              <a href="https://adds-faa.opendata.arcgis.com/" target="_blank" rel="noopener">FAA AIS / ADDS</a>
              ·
              <a href="https://udds-faa.opendata.arcgis.com/" target="_blank" rel="noopener">UDDS</a>
              · UAS Facility Maps informational only (not authorization).
            </div>
          </div>
        </div>
      `;

      this._statusEl = this._slotEl.querySelector("#airspaceStatus");
      const toggle = this._slotEl.querySelector("#airspaceToggle");
      const detail = this._slotEl.querySelector("#airspaceDetailBlock");

      toggle.addEventListener("change", () => {
        this._setEnabled(toggle.checked);
        if (detail) detail.classList.toggle("is-active", toggle.checked);
      });
    },

    _setEnabled(on) {
      this._enabled = !!on;
      if (!this._map) return;

      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = null;
      }

      if (this._enabled) {
        if (!this._group) {
          this._layers.class = L.geoJSON(null, {
            style: (feat) => classStyle(feat.properties && feat.properties.CLASS),
            onEachFeature: (feat, layer) => {
              const p = feat.properties || {};
              layer.bindPopup(
                popupHtml(p.NAME || "Class airspace", [
                  ["Class", p.CLASS],
                  ["Floor", p.LOWER_DESC || p.LOWER_VAL],
                  ["Ceiling", p.UPPER_DESC || p.UPPER_VAL],
                ])
              );
            },
            className: "airspace-class-layer",
          });
          this._layers.sua = L.geoJSON(null, {
            style: (feat) => suaStyle(feat.properties && feat.properties.TYPE_CODE),
            onEachFeature: (feat, layer) => {
              const p = feat.properties || {};
              layer.bindPopup(
                popupHtml(p.NAME || "Special use", [
                  ["Type", p.TYPE_CODE],
                  ["Floor", p.LOWER_DESC || p.LOWER_VAL],
                  ["Ceiling", p.UPPER_DESC || p.UPPER_VAL],
                  ["State", p.STATE],
                ])
              );
            },
            className: "airspace-sua-layer",
          });
          this._layers.uasfm = L.geoJSON(null, {
            style: (feat) =>
              uasfmStyle(feat.properties && feat.properties.CEILING),
            onEachFeature: (feat, layer) => {
              const p = feat.properties || {};
              const apt = p.APT1_NAME || p.APT1_FAAID || "";
              layer.bindPopup(
                popupHtml("UAS Facility Map cell", [
                  ["Ceiling", `${p.CEILING != null ? p.CEILING : "—"} ${p.UNIT || "ft"}`],
                  ["Airport", apt],
                ])
              );
            },
            interactive: true,
            className: "airspace-uasfm-layer",
          });
          this._layers.points = L.layerGroup();
          this._group = L.layerGroup([
            this._layers.uasfm,
            this._layers.sua,
            this._layers.class,
            this._layers.points,
          ]);
        }
        this._group.addTo(this._map);
        this._onMoveEnd = () => this._scheduleRefresh();
        this._map.on("moveend", this._onMoveEnd);
        this._map.on("zoomend", this._onMoveEnd);
        this._scheduleRefresh();
      } else {
        if (this._onMoveEnd && this._map) {
          this._map.off("moveend", this._onMoveEnd);
          this._map.off("zoomend", this._onMoveEnd);
        }
        this._onMoveEnd = null;
        if (this._abort) {
          this._abort.abort();
          this._abort = null;
        }
        if (this._group && this._map) {
          this._map.removeLayer(this._group);
        }
        this._clearLayerData();
        this._setStatus("Overlay off");
      }
    },

    _clearLayerData() {
      if (this._layers.class) this._layers.class.clearLayers();
      if (this._layers.sua) this._layers.sua.clearLayers();
      if (this._layers.uasfm) this._layers.uasfm.clearLayers();
      if (this._layers.points) this._layers.points.clearLayers();
    },

    _setStatus(text) {
      if (this._statusEl) this._statusEl.textContent = text;
    },

    _scheduleRefresh() {
      if (!this._enabled) return;
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => {
        this._debounceTimer = null;
        this._refresh();
      }, DEBOUNCE_MS);
    },

    async _refresh() {
      if (!this._enabled || !this._map) return;
      const zoom = this._map.getZoom();
      if (zoom < MIN_ZOOM) {
        this._clearLayerData();
        this._setStatus(`Zoom in to ≥${MIN_ZOOM} (now ${zoom})`);
        return;
      }

      const bbox = paddedBbox(this._map.getBounds());
      const seq = ++this._fetchSeq;
      if (this._abort) this._abort.abort();
      this._abort = new AbortController();
      const signal = this._abort.signal;

      this._setStatus("Loading FAA airspace…");

      const jobs = [];
      jobs.push(
        this._fetchLayer("classAirspace", bbox, signal).then((gj) => ({
          key: "class",
          gj,
        }))
      );
      jobs.push(
        this._fetchLayer("sua", bbox, signal).then((gj) => ({ key: "sua", gj }))
      );
      if (zoom >= MIN_ZOOM_UASFM) {
        jobs.push(
          this._fetchLayer("uasfm", bbox, signal).then((gj) => ({
            key: "uasfm",
            gj,
          }))
        );
      } else if (this._layers.uasfm) {
        this._layers.uasfm.clearLayers();
      }
      if (zoom >= MIN_ZOOM_POINTS) {
        jobs.push(
          this._fetchLayer("stadiums", bbox, signal).then((gj) => ({
            key: "stadiums",
            gj,
          }))
        );
        jobs.push(
          this._fetchLayer("airports", bbox, signal).then((gj) => ({
            key: "airports",
            gj,
          }))
        );
      }

      try {
        const results = await Promise.all(jobs);
        if (seq !== this._fetchSeq || !this._enabled) return;

        let classN = 0;
        let suaN = 0;
        let uasN = 0;
        let pointN = 0;
        const stadiumFc = { type: "FeatureCollection", features: [] };
        const airportFc = { type: "FeatureCollection", features: [] };

        for (const r of results) {
          if (!r.gj) continue;
          if (r.key === "class") {
            this._layers.class.clearLayers();
            this._layers.class.addData(r.gj);
            classN = (r.gj.features || []).length;
          } else if (r.key === "sua") {
            this._layers.sua.clearLayers();
            this._layers.sua.addData(r.gj);
            suaN = (r.gj.features || []).length;
          } else if (r.key === "uasfm") {
            this._layers.uasfm.clearLayers();
            this._layers.uasfm.addData(r.gj);
            uasN = (r.gj.features || []).length;
          } else if (r.key === "stadiums") {
            stadiumFc.features = r.gj.features || [];
          } else if (r.key === "airports") {
            airportFc.features = r.gj.features || [];
          }
        }

        if (zoom >= MIN_ZOOM_POINTS) {
          pointN = this._renderPoints(stadiumFc, airportFc);
        } else if (this._layers.points) {
          this._layers.points.clearLayers();
        }

        const parts = [`Class ${classN}`, `SUA ${suaN}`];
        if (zoom >= MIN_ZOOM_UASFM) parts.push(`UASFM ${uasN}`);
        else parts.push(`UASFM @z≥${MIN_ZOOM_UASFM}`);
        if (zoom >= MIN_ZOOM_POINTS) parts.push(`pts ${pointN}`);
        this._setStatus(parts.join(" · "));
      } catch (err) {
        if (err && err.name === "AbortError") return;
        console.warn("[AirspaceModule] refresh failed", err);
        this._setStatus("FAA fetch failed — retry by panning");
      }
    },

    async _fetchLayer(key, bbox, signal) {
      const def = LAYERS[key];
      if (!def) return null;
      const url = buildQueryUrl(def, bbox);
      const res = await fetch(url, {
        signal,
        headers: { Accept: "application/geo+json, application/json" },
      });
      if (!res.ok) throw new Error(`${key} HTTP ${res.status}`);
      const gj = await res.json();
      if (!gj || gj.type !== "FeatureCollection") {
        // ArcGIS error payload
        if (gj && gj.error) throw new Error(`${key}: ${gj.error.message || "error"}`);
        return { type: "FeatureCollection", features: [] };
      }
      return gj;
    },

    _renderPoints(stadiumFc, airportFc) {
      this._layers.points.clearLayers();
      let n = 0;

      for (const f of stadiumFc.features || []) {
        const g = f.geometry;
        if (!g || g.type !== "Point" || !g.coordinates) continue;
        const [lng, lat] = g.coordinates;
        const p = f.properties || {};
        const icon = L.divIcon({
          className: "airspace-marker airspace-marker-stadium",
          html: '<i class="fa-solid fa-flag"></i>',
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        });
        L.marker([lat, lng], { icon, title: p.NAME || "Stadium" })
          .bindPopup(
            popupHtml(p.NAME || "Stadium TFR area", [
              ["City", p.CITY],
              ["State", p.STATE],
              ["Note", "Stadium NSFRs — check FAA NOTAMs"],
            ])
          )
          .addTo(this._layers.points);
        n += 1;
      }

      for (const f of airportFc.features || []) {
        const g = f.geometry;
        if (!g || g.type !== "Point" || !g.coordinates) continue;
        const [lng, lat] = g.coordinates;
        const p = f.properties || {};
        const label = p.IDENT || p.ICAO_ID || "APT";
        const icon = L.divIcon({
          className: "airspace-marker airspace-marker-airport",
          html: `<span class="airspace-apt-code">${label}</span>`,
          iconSize: [28, 16],
          iconAnchor: [14, 8],
        });
        L.marker([lat, lng], { icon, title: p.NAME || label })
          .bindPopup(
            popupHtml(p.NAME || label, [
              ["Ident", p.IDENT],
              ["ICAO", p.ICAO_ID],
              ["Type", p.TYPE_CODE],
              ["State", p.STATE],
            ])
          )
          .addTo(this._layers.points);
        n += 1;
      }
      return n;
    },
  };

  global.AirspaceModule = api;
})(window);
