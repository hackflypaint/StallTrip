/**
 * Fall Foliage overlay — Explore Fall–inspired seasonal choropleth for the Lower 48.
 *
 * No free public foliage tile/WMS/GeoJSON feed is used. Explore Fall publishes
 * attribution-required KMLs (not a general tile API). This overlay approximates
 * typical US peak timing by state using a climatological day-of-year model and
 * paints Explore Fall–style stage colors (Little → Peak → Past Peak).
 *
 * Reference date defaults to "today" so mid-October shows Peak across much of
 * the Northeast/Appalachians; deserts & deep South stay muted.
 */

const FOLIAGE_STAGES = [
  { id: "none", label: "Little to No Color", color: "rgba(55, 90, 48, 0.35)", stroke: "#3d5c36" },
  { id: "low", label: "Low Color", color: "rgba(168, 194, 86, 0.45)", stroke: "#8fa84a" },
  { id: "moderate", label: "Moderate Color", color: "rgba(232, 197, 71, 0.50)", stroke: "#c9a52e" },
  { id: "high", label: "High Color", color: "rgba(232, 145, 58, 0.55)", stroke: "#d47828" },
  { id: "peak", label: "Peak Color", color: "rgba(199, 62, 29, 0.58)", stroke: "#a83218" },
  { id: "past", label: "Past Peak Color", color: "rgba(107, 68, 35, 0.50)", stroke: "#5c3a1f" },
];

/** Typical peak day-of-year (1–365) by state — climatological midpoint of usual peak window. */
const FOLIAGE_PEAK_DOY = {
  Maine: 285,
  "New Hampshire": 288,
  Vermont: 282,
  Massachusetts: 295,
  Connecticut: 296,
  "Rhode Island": 298,
  "New York": 288,
  Pennsylvania: 295,
  "New Jersey": 298,
  Maryland: 300,
  Delaware: 300,
  "District of Columbia": 300,
  Virginia: 298,
  "West Virginia": 290,
  "North Carolina": 295,
  Tennessee: 298,
  Kentucky: 295,
  "South Carolina": 308,
  Georgia: 312,
  Alabama: 314,
  Mississippi: 316,
  Florida: 330,
  Louisiana: 320,
  Texas: 318,
  Oklahoma: 302,
  Arkansas: 302,
  Missouri: 295,
  Illinois: 290,
  Indiana: 290,
  Ohio: 288,
  Michigan: 280,
  Wisconsin: 278,
  Minnesota: 274,
  Iowa: 285,
  "North Dakota": 270,
  "South Dakota": 275,
  Nebraska: 285,
  Kansas: 295,
  Colorado: 275,
  "New Mexico": 282,
  Arizona: 288,
  Utah: 276,
  Wyoming: 270,
  Montana: 270,
  Idaho: 276,
  Washington: 300,
  Oregon: 296,
  California: 286,
  Nevada: 280,
  Alaska: 255,
  Hawaii: null, // evergreen / little deciduous color
};

function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date - start;
  return Math.floor(diff / 86400000);
}

/**
 * Map days-from-peak to Explore Fall–style stages.
 * Sparse-deciduous states (FL, HI, desert south) stay mostly "none".
 */
function foliageStageForDelta(deltaDays, peakDoy) {
  if (peakDoy == null) return FOLIAGE_STAGES[0];
  // Outside a wide autumn window, show little color
  if (deltaDays < -45 || deltaDays > 28) return FOLIAGE_STAGES[0];
  if (deltaDays < -28) return FOLIAGE_STAGES[1]; // low
  if (deltaDays < -14) return FOLIAGE_STAGES[2]; // moderate
  if (deltaDays < -5) return FOLIAGE_STAGES[3]; // high
  if (deltaDays <= 5) return FOLIAGE_STAGES[4]; // peak
  if (deltaDays <= 18) return FOLIAGE_STAGES[5]; // past peak
  return FOLIAGE_STAGES[0];
}

function stageForState(stateName, referenceDate) {
  const peak = FOLIAGE_PEAK_DOY[stateName];
  if (peak == null) return FOLIAGE_STAGES[0];
  const doy = dayOfYear(referenceDate);
  return foliageStageForDelta(doy - peak, peak);
}

/**
 * Build a Leaflet GeoJSON overlay layer for Fall Foliage.
 * @param {Date} [referenceDate]
 * @returns {Promise<L.GeoJSON>}
 */
async function createFoliageOverlay(referenceDate = new Date()) {
  const res = await fetch("/data/us-states.json");
  if (!res.ok) throw new Error(`Failed to load foliage regions: ${res.status}`);
  const geojson = await res.json();

  const layer = L.geoJSON(geojson, {
    style(feature) {
      const name = feature.properties && feature.properties.name;
      const stage = stageForState(name, referenceDate);
      return {
        fillColor: stage.color,
        fillOpacity: 1,
        color: stage.stroke,
        weight: 0.8,
        opacity: 0.65,
        interactive: true,
      };
    },
    onEachFeature(feature, lyr) {
      const name = feature.properties.name;
      const stage = stageForState(name, referenceDate);
      lyr.bindTooltip(
        `<strong>${name}</strong><br/><span style="opacity:0.9">${stage.label}</span>`,
        { sticky: true, className: "foliage-tooltip" }
      );
    },
  });

  layer.options = layer.options || {};
  layer.options.foliageReferenceDate = referenceDate.toISOString().slice(0, 10);
  return layer;
}

function buildFoliageLegendHtml(referenceDate = new Date()) {
  const dateLabel = referenceDate.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const swatches = FOLIAGE_STAGES.map(
    (s) =>
      `<div class="foliage-legend-row"><span class="foliage-swatch" style="background:${s.color};border-color:${s.stroke}"></span>${s.label}</div>`
  ).join("");
  return `
    <div class="foliage-legend-title"><i class="fa-solid fa-leaf"></i> Fall Foliage</div>
    <div class="foliage-legend-sub">Seasonal estimate · ${dateLabel}</div>
    ${swatches}
    <div class="foliage-legend-note">Approx. peak timing by state (not live satellite)</div>
  `;
}

// Expose for app.js
window.FoliageOverlay = {
  FOLIAGE_STAGES,
  createFoliageOverlay,
  buildFoliageLegendHtml,
  stageForState,
};
