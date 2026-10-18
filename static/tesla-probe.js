/**
 * Tesla in-car browser fingerprint probe.
 * Served at /tesla-probe (see server.py). External script required — CSP blocks inline JS.
 */
(function () {
  "use strict";

  const rowsEl = document.getElementById("probeRows");
  const copyStatus = document.getElementById("copyStatus");
  const touchPad = document.getElementById("touchPad");

  /** @type {Record<string, unknown>} */
  let lastSnapshot = {};

  function mq(query) {
    try {
      return window.matchMedia(query).matches;
    } catch (_) {
      return null;
    }
  }

  function parseChromiumMajor(ua) {
    if (!ua) return null;
    const m = ua.match(/\b(?:Chromium|Chrome)\/(\d+)\./i);
    return m ? Number(m[1]) : null;
  }

  function classifyGeo(state) {
    if (!state || state.status === "pending") return "warn";
    if (state.status === "granted") return "ok";
    if (state.status === "unsupported") return "warn";
    return "bad";
  }

  function formatGeo(state) {
    if (!state) return "—";
    if (state.status === "pending") return "pending…";
    if (state.status === "unsupported") return "navigator.geolocation unavailable";
    if (state.status === "granted") {
      const lat = Number(state.lat).toFixed(5);
      const lng = Number(state.lng).toFixed(5);
      const acc = state.accuracy != null ? ` ±${Math.round(state.accuracy)}m` : "";
      return `granted ${lat}, ${lng}${acc}`;
    }
    const code = state.code != null ? ` (code ${state.code})` : "";
    return `${state.status}${code}: ${state.message || "denied/unavailable"}`;
  }

  function render(snapshot) {
    lastSnapshot = snapshot;
    const entries = [
      ["userAgent", snapshot.userAgent, ""],
      ["chromiumMajor", snapshot.chromiumMajor != null ? String(snapshot.chromiumMajor) : "unparseable", snapshot.chromiumMajor != null ? "ok" : "warn"],
      ["inner (viewport)", `${snapshot.innerWidth} × ${snapshot.innerHeight}`, ""],
      ["visualViewport", snapshot.visualViewport || "n/a", ""],
      ["screen", `${snapshot.screenWidth} × ${snapshot.screenHeight}`, ""],
      ["availScreen", `${snapshot.availWidth} × ${snapshot.availHeight}`, ""],
      ["devicePixelRatio", String(snapshot.devicePixelRatio), ""],
      ["physical (screen×DPR)", `${snapshot.physicalWidth} × ${snapshot.physicalHeight}`, ""],
      ["maxTouchPoints", String(snapshot.maxTouchPoints), snapshot.maxTouchPoints > 0 ? "ok" : "warn"],
      ["hover MQ", `hover:hover=${snapshot.mqHoverHover}; hover:none=${snapshot.mqHoverNone}`, ""],
      ["pointer MQ", `pointer:fine=${snapshot.mqPointerFine}; pointer:coarse=${snapshot.mqPointerCoarse}`, ""],
      ["any-hover / any-pointer", `any-hover:hover=${snapshot.mqAnyHoverHover}; any-pointer:coarse=${snapshot.mqAnyPointerCoarse}`, ""],
      ["geolocation", formatGeo(snapshot.geolocation), classifyGeo(snapshot.geolocation)],
      ["touchSmoke", snapshot.touchSmoke || "no touch event yet", snapshot.touchSmoke ? "ok" : "warn"],
      ["platform / vendor", `${snapshot.platform || "?"} · ${snapshot.vendor || "?"}`, ""],
      ["capturedAt", snapshot.capturedAt, ""],
    ];

    rowsEl.innerHTML = "";
    for (const [label, value, cls] of entries) {
      const row = document.createElement("div");
      row.className = "row";
      const lab = document.createElement("div");
      lab.className = "label";
      lab.textContent = label;
      const val = document.createElement("div");
      val.className = "value" + (cls ? " " + cls : "");
      val.textContent = value == null ? "—" : String(value);
      row.appendChild(lab);
      row.appendChild(val);
      rowsEl.appendChild(row);
    }
  }

  function baseSnapshot(geoState, touchSmoke) {
    const dpr = window.devicePixelRatio || 1;
    const ua = navigator.userAgent || "";
    let visualViewport = null;
    if (window.visualViewport) {
      visualViewport = `${Math.round(window.visualViewport.width)} × ${Math.round(window.visualViewport.height)}`;
    }
    return {
      userAgent: ua,
      chromiumMajor: parseChromiumMajor(ua),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      visualViewport,
      screenWidth: screen.width,
      screenHeight: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      devicePixelRatio: dpr,
      physicalWidth: Math.round(screen.width * dpr),
      physicalHeight: Math.round(screen.height * dpr),
      maxTouchPoints: navigator.maxTouchPoints || 0,
      mqHoverHover: mq("(hover: hover)"),
      mqHoverNone: mq("(hover: none)"),
      mqPointerFine: mq("(pointer: fine)"),
      mqPointerCoarse: mq("(pointer: coarse)"),
      mqAnyHoverHover: mq("(any-hover: hover)"),
      mqAnyPointerCoarse: mq("(any-pointer: coarse)"),
      geolocation: geoState,
      touchSmoke: touchSmoke || (lastSnapshot.touchSmoke || null),
      platform: navigator.platform || "",
      vendor: navigator.vendor || "",
      capturedAt: new Date().toISOString(),
    };
  }

  function attemptGeolocation() {
    const pending = { status: "pending" };
    render(baseSnapshot(pending, lastSnapshot.touchSmoke));

    if (!navigator.geolocation || typeof navigator.geolocation.getCurrentPosition !== "function") {
      const unsupported = { status: "unsupported" };
      render(baseSnapshot(unsupported, lastSnapshot.touchSmoke));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        render(
          baseSnapshot(
            {
              status: "granted",
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              accuracy: pos.coords.accuracy,
            },
            lastSnapshot.touchSmoke
          )
        );
      },
      (err) => {
        const name =
          err && err.code === 1
            ? "denied"
            : err && err.code === 2
              ? "unavailable"
              : err && err.code === 3
                ? "timeout"
                : "error";
        render(
          baseSnapshot(
            {
              status: name,
              code: err ? err.code : null,
              message: err && err.message ? err.message : "geolocation failed",
            },
            lastSnapshot.touchSmoke
          )
        );
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 0 }
    );
  }

  function refresh() {
    copyStatus.textContent = "";
    attemptGeolocation();
  }

  async function copyJson() {
    const text = JSON.stringify(lastSnapshot, null, 2);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      copyStatus.textContent = "Fingerprint JSON copied to clipboard.";
    } catch (e) {
      copyStatus.textContent = "Copy failed — screenshot the table instead.";
    }
  }

  function markTouch(kind, ev) {
    const pts =
      ev && ev.touches && typeof ev.touches.length === "number"
        ? ev.touches.length
        : ev && ev.pointerType
          ? 1
          : 0;
    const smoke = `${kind} @ ${new Date().toISOString()}${pts ? ` (touches=${pts})` : ""}`;
    touchPad.classList.add("hit");
    touchPad.textContent = "Touch detected — " + kind;
    render(baseSnapshot(lastSnapshot.geolocation || { status: "pending" }, smoke));
  }

  document.getElementById("btnRefresh").addEventListener("click", refresh);
  document.getElementById("btnGeo").addEventListener("click", attemptGeolocation);
  document.getElementById("btnCopy").addEventListener("click", copyJson);

  touchPad.addEventListener("touchstart", (ev) => markTouch("touchstart", ev), { passive: true });
  touchPad.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "touch" || ev.pointerType === "pen") {
      markTouch("pointerdown:" + ev.pointerType, ev);
    }
  });
  // Mouse click still counts as interaction smoke in desktop emulation
  touchPad.addEventListener("click", () => {
    if (!lastSnapshot.touchSmoke) {
      markTouch("click", null);
    }
  });

  refresh();
})();
