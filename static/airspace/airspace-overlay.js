/**
 * Removable drone flight-constraint overlay — FAA + NPS public FeatureServers.
 *
 * Answers (informationally): no-fly / authorization required / unconstrained.
 * Sources: FAA AIS/UDDS ArcGIS + official NPS Land Resources boundaries.
 * Never Autopylot private APIs. Not a LAANC / authorization product.
 *
 * Each shown constraint class is independently toggleable in the Layers UI.
 * Restricted (R) SUA is hard no-fly (not auth-required).
 *
 * See README.md for URLs, legality mapping, and removal steps.
 */
(function (global) {
  "use strict";

  const FAA_ORG =
    "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services";
  /** Official NPS Land Resources Division boundaries (public FeatureServer). */
  const NPS_ORG = "https://services1.arcgis.com/fBc8EJBxQRMcHlei/arcgis/rest/services";

  /** Min map zoom before any fetch (avoid loading half of CONUS). */
  const MIN_ZOOM = 7;
  /** UAS Facility Map cells are dense — only at closer zooms. */
  const MIN_ZOOM_UASFM = 9;
  /** Stadium / NSFR point markers. */
  const MIN_ZOOM_POINTS = 8;

  const DEBOUNCE_MS = 350;
  const BBOX_PAD_DEG = 0.08;
  const MAX_CLASS = 800;
  const MAX_SUA = 500;
  const MAX_UASFM = 1500;
  const MAX_NPS = 400;
  const MAX_TFR = 200;
  const MAX_POINTS = 200;

  /**
   * Pilot-facing constraint classes shown in the UI.
   * Each has an independent Show toggle under Drone flight.
   */
  const CLASS_KEYS = {
    noFly: "noFly",
    parks: "parks",
    auth: "auth",
  };

  const CONSTRAINT = {
    noFly: "no-fly",
    auth: "auth",
  };

  const STYLES = {
    noFly: {
      color: "#e85d5d",
      weight: 1.6,
      opacity: 0.95,
      fillColor: "#c0392b",
      fillOpacity: 0.32,
    },
    /** NPS parks — same legality class, distinct hue so parks read clearly. */
    park: {
      color: "#d35400",
      weight: 1.5,
      opacity: 0.9,
      fillColor: "#a04000",
      fillOpacity: 0.3,
    },
    auth: {
      color: "#e8b84a",
      weight: 1.4,
      opacity: 0.85,
      fillColor: "#c9942e",
      fillOpacity: 0.18,
      dashArray: "4 3",
    },
    /** UASFM cells with a published ceiling > 0 ft — still auth-required. */
    uasfmAuth: {
      color: "#d4a84b",
      weight: 0.35,
      opacity: 0.55,
      fillColor: "#c9942e",
      fillOpacity: 0.22,
    },
    /** UASFM ceiling 0 — no LAANC grid authorization; treat as no-fly. */
    uasfmZero: {
      color: "#c0392b",
      weight: 0.4,
      opacity: 0.65,
      fillColor: "#922b21",
      fillOpacity: 0.4,
    },
  };

  /**
   * Layer defs. `base` overrides FAA_ORG for NPS.
   * `constraint` is the pilot-facing legality class.
   * Restricted (R) SUA is hard no-fly — never mapped to auth.
   */
  const LAYERS = {
    npsParks: {
      base: NPS_ORG,
      path: "NPS_Land_Resources_Division_Boundary_and_Tract_Data_Service/FeatureServer/2",
      where: "1=1",
      outFields: "UNIT_NAME,UNIT_CODE,UNIT_TYPE,STATE,PARKNAME,Status",
      max: MAX_NPS,
      minZoom: MIN_ZOOM,
      constraint: CONSTRAINT.noFly,
      classKey: CLASS_KEYS.parks,
    },
    /** Prohibited + Restricted SUA — both hard no-fly (R is not auth-required). */
    suaNoFly: {
      path: "Special_Use_Airspace/FeatureServer/0",
      where: "TYPE_CODE IN ('P','R')",
      outFields: "NAME,TYPE_CODE,LOWER_VAL,UPPER_VAL,LOWER_DESC,UPPER_DESC,STATE",
      max: MAX_SUA,
      minZoom: MIN_ZOOM,
      constraint: CONSTRAINT.noFly,
      classKey: CLASS_KEYS.noFly,
      /** Product rule: Restricted (R) SUA = hard no-fly. */
      restrictedIsHardNoFly: true,
    },
    defenseTfr: {
      path: "National_Defense_Airspace_TFR_Areas/FeatureServer/0",
      where: "1=1",
      outFields: "NAME,TYPE_CODE,LOCAL_TYPE,CITY,STATE",
      max: MAX_TFR,
      minZoom: MIN_ZOOM,
      constraint: CONSTRAINT.noFly,
      classKey: CLASS_KEYS.noFly,
    },
    classAuth: {
      path: "Class_Airspace/FeatureServer/0",
      where: "CLASS IN ('B','C','D')",
      outFields: "NAME,CLASS,TYPE_CODE,LOWER_VAL,UPPER_VAL,LOWER_DESC,UPPER_DESC",
      max: MAX_CLASS,
      minZoom: MIN_ZOOM,
      constraint: CONSTRAINT.auth,
      classKey: CLASS_KEYS.auth,
    },
    uasfm: {
      path: "FAA_UAS_FacilityMap_Data/FeatureServer/0",
      where: "1=1",
      outFields: "CEILING,UNIT,APT1_FAAID,APT1_NAME,APT1_ICAO",
      max: MAX_UASFM,
      minZoom: MIN_ZOOM_UASFM,
      constraint: CONSTRAINT.auth,
    },
    stadiums: {
      path: "Stadiums/FeatureServer/0",
      where: "1=1",
      outFields: "NAME,CITY,STATE",
      max: MAX_POINTS,
      minZoom: MIN_ZOOM_POINTS,
      constraint: CONSTRAINT.noFly,
      classKey: CLASS_KEYS.noFly,
    },
  };

  function constraintLabel(kind) {
    if (kind === CONSTRAINT.noFly) return "No-fly";
    if (kind === CONSTRAINT.auth) return "Auth required";
    return "Constraint";
  }

  function uasfmConstraint(ceiling) {
    const c = Number(ceiling);
    if (!Number.isFinite(c) || c <= 0) return CONSTRAINT.noFly;
    return CONSTRAINT.auth;
  }

  function uasfmStyle(ceiling) {
    return uasfmConstraint(ceiling) === CONSTRAINT.noFly
      ? Object.assign({}, STYLES.uasfmZero)
      : Object.assign({}, STYLES.uasfmAuth);
  }

  /** Restricted (R) and Prohibited (P) SUA → hard no-fly. */
  function suaConstraint(typeCode) {
    const t = String(typeCode || "").toUpperCase();
    if (t === "P" || t === "R") return CONSTRAINT.noFly;
    return CONSTRAINT.noFly;
  }

  function buildQueryUrl(layerDef, bboxStr) {
    const base = layerDef.base || FAA_ORG;
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
    return `${base}/${layerDef.path}/query?${params.toString()}`;
  }

  function paddedBbox(bounds) {
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const pad = BBOX_PAD_DEG;
    const west = Math.max(-180, sw.lng - pad);
    const south = Math.max(-90, sw.lat - pad);
    const east = Math.min(180, ne.lng + pad);
    const north = Math.min(90, ne.lat + pad);
    return `${west},${south},${east},${north}`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function popupHtml(title, constraintKind, rows) {
    const badge = constraintLabel(constraintKind);
    const badgeClass =
      constraintKind === CONSTRAINT.noFly
        ? "airspace-badge-nofly"
        : "airspace-badge-auth";
    const body = rows
      .filter(([, v]) => v != null && v !== "")
      .map(
        ([k, v]) =>
          `<div class="airspace-popup-row"><span>${escapeHtml(k)}</span><strong>${escapeHtml(v)}</strong></div>`
      )
      .join("");
    return `<div class="airspace-popup"><div class="airspace-popup-title">${escapeHtml(title)}</div><div class="airspace-badge ${badgeClass}">${escapeHtml(badge)}</div>${body}</div>`;
  }

  const api = {
    _map: null,
    _slotEl: null,
    _enabled: false,
    _group: null,
    _layers: {
      parks: null,
      noFlyPoly: null,
      authPoly: null,
      uasfmNoFly: null,
      uasfmAuth: null,
      points: null,
    },
    /** Independent visibility for each shown constraint class. */
    _classOn: {
      noFly: true,
      parks: true,
      auth: true,
    },
    _abort: null,
    _debounceTimer: null,
    _onMoveEnd: null,
    _statusEl: null,
    _fetchSeq: 0,
    _lastCounts: null,

    // Exported for unit tests
    _test: {
      STYLES,
      CONSTRAINT,
      CLASS_KEYS,
      constraintLabel,
      uasfmConstraint,
      uasfmStyle,
      suaConstraint,
      buildQueryUrl,
      LAYERS,
      FAA_ORG,
      NPS_ORG,
      MIN_ZOOM,
      MIN_ZOOM_UASFM,
      MIN_ZOOM_POINTS,
    },

    /**
     * @param {{ map: L.Map, slotEl: HTMLElement }} opts
     */
    mount(opts) {
      if (!opts || !opts.map || !opts.slotEl || typeof L === "undefined") return;
      this.unmount();
      this._map = opts.map;
      this._slotEl = opts.slotEl;
      this._classOn = { noFly: true, parks: true, auth: true };
      this._renderSlot();
    },

    unmount() {
      this._setEnabled(false);
      if (this._slotEl) this._slotEl.innerHTML = "";
      this._map = null;
      this._slotEl = null;
      this._statusEl = null;
      this._group = null;
      this._layers = {
        parks: null,
        noFlyPoly: null,
        authPoly: null,
        uasfmNoFly: null,
        uasfmAuth: null,
        points: null,
      };
      this._classOn = { noFly: true, parks: true, auth: true };
      this._lastCounts = null;
    },

    isEnabled() {
      return this._enabled;
    },

    /** @returns {{ noFly: boolean, parks: boolean, auth: boolean }} */
    getClassVisibility() {
      return Object.assign({}, this._classOn);
    },

    _renderSlot() {
      this._slotEl.innerHTML = `
        <div class="airspace-slot">
          <div class="airspace-slot-header">
            <div class="airspace-slot-title"><i class="fa-solid fa-plane-up"></i> Drone flight</div>
            <label class="airspace-toggle">
              <input type="checkbox" id="airspaceToggle" />
              Show
            </label>
          </div>
          <div class="airspace-detail-block" id="airspaceDetailBlock">
            <p class="airspace-blurb">Constraints for whether recreational / Part&nbsp;107 flight is typically blocked, needs airspace authorization, or unconstrained. Not a LAANC approval tool. Restricted (R) SUA is hard no-fly.</p>
            <div class="airspace-class-toggles" id="airspaceClassToggles" role="group" aria-label="Constraint classes">
              <label class="airspace-class-toggle">
                <input type="checkbox" id="airspaceClassNoFly" data-class="noFly" checked />
                <i class="airspace-swatch airspace-swatch-nofly"></i>
                <span>No-fly</span>
              </label>
              <label class="airspace-class-toggle">
                <input type="checkbox" id="airspaceClassParks" data-class="parks" checked />
                <i class="airspace-swatch airspace-swatch-park"></i>
                <span>National park (no-fly)</span>
              </label>
              <label class="airspace-class-toggle">
                <input type="checkbox" id="airspaceClassAuth" data-class="auth" checked />
                <i class="airspace-swatch airspace-swatch-auth"></i>
                <span>Auth required</span>
              </label>
            </div>
            <div class="airspace-status" id="airspaceStatus">Zoom in (≥${MIN_ZOOM}) for constraints</div>
            <div class="airspace-credit">
              FAA AIS / ADDS ·
              <a href="https://udds-faa.opendata.arcgis.com/" target="_blank" rel="noopener">UDDS</a>
              ·
              <a href="https://www.nps.gov/articles/uncrewed-aircraft-in-the-national-parks.htm" target="_blank" rel="noopener">NPS UAS policy</a>
              · blank areas ≠ legal clearance.
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

      const classInputs = this._slotEl.querySelectorAll(
        "#airspaceClassToggles input[data-class]"
      );
      classInputs.forEach((input) => {
        input.addEventListener("change", () => {
          const key = input.getAttribute("data-class");
          if (!key || !(key in this._classOn)) return;
          this._classOn[key] = !!input.checked;
          this._applyClassVisibility();
          this._updateVisibilityStatus();
        });
      });
    },

    _formatStatus(counts) {
      const c = counts || this._lastCounts;
      if (!c) return null;
      const vis = this._classOn;
      const parts = [];
      parts.push(vis.noFly ? `No-fly ${c.noFly}` : "No-fly off");
      parts.push(vis.parks ? `Parks ${c.parks}` : "Parks off");
      parts.push(vis.auth ? `Auth ${c.auth}` : "Auth off");
      if (c.uasfmNote) parts.push(c.uasfmNote);
      return parts.join(" · ");
    },

    _updateVisibilityStatus() {
      const text = this._formatStatus();
      if (text) this._setStatus(text);
    },

    _layerRefsForClass(classKey) {
      if (classKey === CLASS_KEYS.noFly) {
        return [
          this._layers.noFlyPoly,
          this._layers.uasfmNoFly,
          this._layers.points,
        ];
      }
      if (classKey === CLASS_KEYS.parks) {
        return [this._layers.parks];
      }
      if (classKey === CLASS_KEYS.auth) {
        return [this._layers.authPoly, this._layers.uasfmAuth];
      }
      return [];
    },

    _applyClassVisibility() {
      if (!this._group || !this._enabled) return;
      for (const key of Object.keys(this._classOn)) {
        const on = !!this._classOn[key];
        for (const layer of this._layerRefsForClass(key)) {
          if (!layer) continue;
          const has = this._group.hasLayer(layer);
          if (on && !has) this._group.addLayer(layer);
          if (!on && has) this._group.removeLayer(layer);
        }
      }
    },

    _ensureLayers() {
      if (this._group) return;

      this._layers.authPoly = L.geoJSON(null, {
        style: () => Object.assign({}, STYLES.auth),
        onEachFeature: (feat, layer) => {
          const p = feat.properties || {};
          layer.bindPopup(
            popupHtml(p.NAME || "Controlled airspace", CONSTRAINT.auth, [
              ["Class", p.CLASS],
              ["Floor", p.LOWER_DESC || p.LOWER_VAL],
              ["Ceiling", p.UPPER_DESC || p.UPPER_VAL],
              ["Note", "Class B/C/D — airspace authorization typically required"],
            ])
          );
        },
        className: "airspace-auth-layer",
      });

      this._layers.uasfmAuth = L.geoJSON(null, {
        style: () => Object.assign({}, STYLES.uasfmAuth),
        onEachFeature: (feat, layer) => {
          const p = feat.properties || {};
          const apt = p.APT1_NAME || p.APT1_FAAID || "";
          layer.bindPopup(
            popupHtml("UAS Facility Map cell", CONSTRAINT.auth, [
              ["Ceiling", `${p.CEILING != null ? p.CEILING : "—"} ${p.UNIT || "ft"}`],
              ["Airport", apt],
              ["Note", "UASFM ceiling — authorization typically required below/near airport"],
            ])
          );
        },
        interactive: true,
        className: "airspace-uasfm-auth-layer",
      });

      this._layers.uasfmNoFly = L.geoJSON(null, {
        style: () => Object.assign({}, STYLES.uasfmZero),
        onEachFeature: (feat, layer) => {
          const p = feat.properties || {};
          const apt = p.APT1_NAME || p.APT1_FAAID || "";
          layer.bindPopup(
            popupHtml("UAS Facility Map cell", CONSTRAINT.noFly, [
              ["Ceiling", `${p.CEILING != null ? p.CEILING : "—"} ${p.UNIT || "ft"}`],
              ["Airport", apt],
              ["Note", "0 ft UASFM cell — no LAANC grid; hard no-fly"],
            ])
          );
        },
        interactive: true,
        className: "airspace-uasfm-nofly-layer",
      });

      this._layers.noFlyPoly = L.geoJSON(null, {
        style: () => Object.assign({}, STYLES.noFly),
        onEachFeature: (feat, layer) => {
          const p = feat.properties || {};
          const src = p._airspaceSource;
          if (src === "defenseTfr") {
            layer.bindPopup(
              popupHtml(p.NAME || "National defense TFR", CONSTRAINT.noFly, [
                ["Type", p.TYPE_CODE || p.LOCAL_TYPE],
                ["City", p.CITY],
                ["State", p.STATE],
                ["Note", "National defense UAS TFR — hard no-fly"],
              ])
            );
            return;
          }
          const code = String(p.TYPE_CODE || "").toUpperCase();
          const typeLabel =
            code === "P" ? "Prohibited" : code === "R" ? "Restricted" : p.TYPE_CODE;
          const note =
            code === "R"
              ? "Restricted (R) SUA — hard no-fly for UAS"
              : code === "P"
                ? "Prohibited (P) SUA — hard no-fly"
                : "Special-use airspace — hard no-fly for UAS";
          layer.bindPopup(
            popupHtml(p.NAME || "Special use", suaConstraint(p.TYPE_CODE), [
              ["Type", typeLabel],
              ["Floor", p.LOWER_DESC || p.LOWER_VAL],
              ["Ceiling", p.UPPER_DESC || p.UPPER_VAL],
              ["State", p.STATE],
              ["Note", note],
            ])
          );
        },
        className: "airspace-nofly-layer",
      });

      this._layers.parks = L.geoJSON(null, {
        style: () => Object.assign({}, STYLES.park),
        onEachFeature: (feat, layer) => {
          const p = feat.properties || {};
          layer.bindPopup(
            popupHtml(
              p.UNIT_NAME || p.PARKNAME || "National Park Service unit",
              CONSTRAINT.noFly,
              [
                ["Unit", p.UNIT_CODE],
                ["Type", p.UNIT_TYPE],
                ["State", p.STATE],
                [
                  "Note",
                  "NPS lands — launch/land/operate UAS generally prohibited (park policy)",
                ],
              ]
            )
          );
        },
        className: "airspace-park-layer",
      });

      this._layers.points = L.layerGroup();

      // Start with all class layers in the group; visibility applied after.
      this._group = L.layerGroup([
        this._layers.uasfmAuth,
        this._layers.authPoly,
        this._layers.uasfmNoFly,
        this._layers.noFlyPoly,
        this._layers.parks,
        this._layers.points,
      ]);
    },

    _setEnabled(on) {
      this._enabled = !!on;
      if (!this._map) return;

      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = null;
      }

      if (this._enabled) {
        this._ensureLayers();
        this._group.addTo(this._map);
        this._applyClassVisibility();
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
        this._lastCounts = null;
        this._setStatus("Overlay off");
      }
    },

    _clearLayerData() {
      if (this._layers.parks) this._layers.parks.clearLayers();
      if (this._layers.noFlyPoly) this._layers.noFlyPoly.clearLayers();
      if (this._layers.authPoly) this._layers.authPoly.clearLayers();
      if (this._layers.uasfmNoFly) this._layers.uasfmNoFly.clearLayers();
      if (this._layers.uasfmAuth) this._layers.uasfmAuth.clearLayers();
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

    _tagFeatures(gj, source) {
      if (!gj || !gj.features) return gj;
      for (const f of gj.features) {
        if (!f.properties) f.properties = {};
        f.properties._airspaceSource = source;
      }
      return gj;
    },

    _splitUasfm(gj) {
      const zero = { type: "FeatureCollection", features: [] };
      const auth = { type: "FeatureCollection", features: [] };
      for (const f of gj.features || []) {
        if (uasfmConstraint((f.properties || {}).CEILING) === CONSTRAINT.noFly) {
          zero.features.push(f);
        } else {
          auth.features.push(f);
        }
      }
      return { zero, auth };
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

      this._setStatus("Loading drone constraints…");

      const jobs = [
        this._fetchLayer("npsParks", bbox, signal).then((gj) => ({
          key: "parks",
          gj,
        })),
        this._fetchLayer("suaNoFly", bbox, signal).then((gj) => ({
          key: "sua",
          gj: this._tagFeatures(gj, "sua"),
        })),
        this._fetchLayer("defenseTfr", bbox, signal).then((gj) => ({
          key: "defenseTfr",
          gj: this._tagFeatures(gj, "defenseTfr"),
        })),
        this._fetchLayer("classAuth", bbox, signal).then((gj) => ({
          key: "class",
          gj,
        })),
      ];
      if (zoom >= MIN_ZOOM_UASFM) {
        jobs.push(
          this._fetchLayer("uasfm", bbox, signal).then((gj) => ({
            key: "uasfm",
            gj,
          }))
        );
      } else {
        if (this._layers.uasfmNoFly) this._layers.uasfmNoFly.clearLayers();
        if (this._layers.uasfmAuth) this._layers.uasfmAuth.clearLayers();
      }
      if (zoom >= MIN_ZOOM_POINTS) {
        jobs.push(
          this._fetchLayer("stadiums", bbox, signal).then((gj) => ({
            key: "stadiums",
            gj,
          }))
        );
      }

      try {
        const results = await Promise.all(jobs);
        if (seq !== this._fetchSeq || !this._enabled) return;

        let parkN = 0;
        let noFlyN = 0;
        let authN = 0;
        let uasN = 0;
        let uasZeroN = 0;
        let stadiumN = 0;
        const suaFc = { type: "FeatureCollection", features: [] };
        const tfrFc = { type: "FeatureCollection", features: [] };

        for (const r of results) {
          if (!r.gj) continue;
          if (r.key === "parks") {
            this._layers.parks.clearLayers();
            this._layers.parks.addData(r.gj);
            parkN = (r.gj.features || []).length;
          } else if (r.key === "sua") {
            suaFc.features = r.gj.features || [];
          } else if (r.key === "defenseTfr") {
            tfrFc.features = r.gj.features || [];
          } else if (r.key === "class") {
            this._layers.authPoly.clearLayers();
            this._layers.authPoly.addData(r.gj);
            authN = (r.gj.features || []).length;
          } else if (r.key === "uasfm") {
            const split = this._splitUasfm(r.gj);
            this._layers.uasfmNoFly.clearLayers();
            this._layers.uasfmAuth.clearLayers();
            this._layers.uasfmNoFly.addData(split.zero);
            this._layers.uasfmAuth.addData(split.auth);
            uasZeroN = split.zero.features.length;
            uasN = uasZeroN + split.auth.features.length;
          } else if (r.key === "stadiums") {
            stadiumN = this._renderStadiums(r.gj);
          }
        }

        this._layers.noFlyPoly.clearLayers();
        this._layers.noFlyPoly.addData({
          type: "FeatureCollection",
          features: [...suaFc.features, ...tfrFc.features],
        });
        noFlyN =
          suaFc.features.length + tfrFc.features.length + stadiumN + uasZeroN;

        if (zoom < MIN_ZOOM_POINTS && this._layers.points) {
          this._layers.points.clearLayers();
        }

        this._applyClassVisibility();

        this._lastCounts = {
          noFly: noFlyN,
          parks: parkN,
          auth: authN,
          uasfmNote:
            zoom >= MIN_ZOOM_UASFM
              ? `UASFM ${uasN}${uasZeroN ? ` (${uasZeroN} @0ft)` : ""}`
              : `UASFM @z≥${MIN_ZOOM_UASFM}`,
        };
        this._setStatus(this._formatStatus(this._lastCounts));
      } catch (err) {
        if (err && err.name === "AbortError") return;
        console.warn("[AirspaceModule] refresh failed", err);
        this._setStatus("Constraint fetch failed — retry by panning");
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
        if (gj && gj.error) throw new Error(`${key}: ${gj.error.message || "error"}`);
        return { type: "FeatureCollection", features: [] };
      }
      return gj;
    },

    _renderStadiums(stadiumFc) {
      this._layers.points.clearLayers();
      let n = 0;
      for (const f of stadiumFc.features || []) {
        const g = f.geometry;
        if (!g || g.type !== "Point" || !g.coordinates) continue;
        const [lng, lat] = g.coordinates;
        const p = f.properties || {};
        const icon = L.divIcon({
          className: "airspace-marker airspace-marker-stadium",
          html: '<i class="fa-solid fa-ban"></i>',
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        });
        L.marker([lat, lng], { icon, title: p.NAME || "Stadium NSFR" })
          .bindPopup(
            popupHtml(p.NAME || "Stadium NSFR", CONSTRAINT.noFly, [
              ["City", p.CITY],
              ["State", p.STATE],
              ["Note", "Stadium NSFR — no-fly during covered events; check NOTAMs"],
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
