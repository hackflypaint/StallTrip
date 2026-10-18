# Elevation-Aware Battery & Grade Profile Strip (removable)

100% client-side route elevation & grade profiling module for the Tesla Supercharger Route Planner, powered by the **Tesla in-car Navigation / Energy App longitudinal vehicle dynamics model**.

## Overview

When a route is planned, `ElevationModule` samples ~50 equidistant coordinates along the route polyline (`plan.geometry.coordinates` or `plan.stops` fallback) and queries the free, no-key **Open-Meteo Elevation API** directly from the browser:

- Endpoint: `https://api.open-meteo.com/v1/elevation?latitude=...&longitude=...`
- Supports up to 100 coordinates per GET request, CORS `*`, zero server cost.
- Includes a deterministic synthetic terrain fallback (`generateSyntheticElevations`) if the browser is offline or upstream is unreachable.

## Tesla Longitudinal Vehicle Dynamics & Potential Energy Model

For each segment \(i\) with horizontal distance \(\Delta d_i\) (m), elevation change \(\Delta h_i = h_{i+1} - h_i\) (m), and road grade \(G_i = (\Delta h_i / \Delta d_i) \times 100\%\):

1. **Gravitational Potential Energy**:
   \[
   \Delta E_{\text{pot},i} = \frac{m \cdot g \cdot |\Delta h_i|}{3{,}600{,}000}\text{ kWh}, \quad g = 9.80665\text{ m/s}^2
   \]
2. **Tesla Vehicle Mass Presets (\(m = m_{\text{curb}} + m_{\text{payload}}\))**:
   - **Model 3 LR** (`model3_lr`): \(1{,}980\text{ kg}\), \(75\text{ kWh}\) pack, \(C_d A = 0.48\text{ m}^2\), \(P_{\text{regen,max}} = 65\text{ kW}\)
   - **Model Y LR** (`modely_lr`, default): \(2{,}130\text{ kg}\), \(75\text{ kWh}\) pack, \(C_d A = 0.56\text{ m}^2\), \(P_{\text{regen,max}} = 70\text{ kW}\)
   - **Model S / X** (`models_x`): \(2{,}350\text{ kg}\), \(100\text{ kWh}\) pack, \(C_d A = 0.51\text{ m}^2\), \(P_{\text{regen,max}} = 75\text{ kW}\)
   - **Cybertruck** (`cybertruck`): \(3{,}150\text{ kg}\), \(123\text{ kWh}\) pack, \(C_d A = 0.92\text{ m}^2\), \(P_{\text{regen,max}} = 85\text{ kW}\)
3. **Climbing Tractive Penalty (\(\Delta h_i > 0\))**:
   \[
   \Delta E_{\text{climb},i} = \frac{\Delta E_{\text{pot},i}}{\eta_{\text{climb}}(G_i)}, \quad \eta_{\text{drive}} = 0.90\text{ (with high-load }I^2R\text{ derating above }3\%\text{ grade)}
   \]
4. **Two-Regime Downhill Energy Recovery (\(\Delta h_i < 0\))**:
   - Zero-torque coasting grade \(G_{\text{coast}} = -\frac{\frac{1}{2}\rho C_d A v^2 + m g C_{rr}}{m g} \times 100\% \approx -2.2\%\) at \(65\text{ mph}\).
   - **Gentle Descent (\(0 > G_i \ge G_{\text{coast}}\))**: Gravity directly offsets forward tractive motor draw without battery inversion losses (\(\eta_{\text{shallow}} = 0.85\)).
   - **Steep Descent (\(G_i < G_{\text{coast}}\))**: Excess downhill power drives active regenerative braking through the SiC inverter into the Li-ion battery pack at round-trip efficiency \(\eta_{\text{regen}} = 0.75\), capped by \(P_{\text{regen,max}}\) over segment travel time \(\Delta t_i = \Delta d_i / v\).
5. **Net Battery Impact**:
   - Displays **Climb (`+kWh`)**, **Regen (`−kWh`)**, **Net (`±kWh`)**, **Net SoC % (`±% SoC`)**, and **Net `±Wh/mi`** in the strip header.

## Files

| Path | Role |
| --- | --- |
| `elevation-profile.js` | `window.ElevationModule` API, sampling, Open-Meteo fetch + fallback, Tesla longitudinal physics math, SVG chart & Leaflet scrub marker |
| `elevation.css` | Responsive bottom strip styles for desktop, `/mobile`, and `/tesla` car-shell |
| `README.md` | This documentation |

## How to remove later

1. Delete `static/elevation/` entirely.
2. In `static/index.html`, remove the `<link rel="stylesheet" href="/elevation/elevation.css...">` and `<script src="/elevation/elevation-profile.js..."></script>` lines.
3. In `static/app.js`, remove the optional `ElevationModule` mount / `routePlanned` hook.
4. Remove `tests/test_elevation.js`.
