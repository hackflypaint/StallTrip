"""
Tesla Supercharger Routing and Recommendation Engine.
Computes routes, corridor spatial queries, and optimal Supercharger stops.
"""

import json
import math
import os
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

DATA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "superchargers.json")
OSRM_BASE_URL = "http://router.project-osrm.org"
PHOTON_BASE_URL = "https://photon.komoot.io/api"
NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org"

# In-memory store of all Superchargers
SUPERCHARGERS: List[Dict[str, Any]] = []

def load_superchargers() -> List[Dict[str, Any]]:
    global SUPERCHARGERS
    if SUPERCHARGERS:
        return SUPERCHARGERS
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            SUPERCHARGERS = json.load(f)
            print(f"Loaded {len(SUPERCHARGERS)} Superchargers into memory.")
    else:
        print(f"Warning: Data file {DATA_FILE} not found.")
    return SUPERCHARGERS

def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two points in kilometers."""
    R = 6371.0088
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (math.sin(delta_phi / 2.0) ** 2 +
         math.cos(phi1) * math.cos(phi2) * (math.sin(delta_lambda / 2.0) ** 2))
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))
    return R * c

def distance_point_to_segment_km(px: float, py: float, x1: float, y1: float, x2: float, y2: float) -> Tuple[float, float]:
    """
    Computes minimum distance in km from point P(lat, lng) to segment AB.
    Returns (distance_km, projection_ratio_t in [0, 1]).
    Using equirectangular planar projection around segment midpoint.
    """
    mid_lat_rad = math.radians((y1 + y2) / 2.0)
    kx = 111.320 * math.cos(mid_lat_rad)  # km per deg longitude
    ky = 110.574                          # km per deg latitude

    P_x = px * kx
    P_y = py * ky
    A_x = x1 * kx
    A_y = y1 * ky
    B_x = x2 * kx
    B_y = y2 * ky

    dx = B_x - A_x
    dy = B_y - A_y
    seg_len_sq = dx * dx + dy * dy
    if seg_len_sq <= 1e-9:
        dist = math.hypot(P_x - A_x, P_y - A_y)
        return dist, 0.0

    t = max(0.0, min(1.0, ((P_x - A_x) * dx + (P_y - A_y) * dy) / seg_len_sq))
    proj_x = A_x + t * dx
    proj_y = A_y + t * dy
    dist = math.hypot(P_x - proj_x, P_y - proj_y)
    return dist, t

def query_superchargers(
    bounds: Optional[Dict[str, float]] = None,
    center_lat: Optional[float] = None,
    center_lng: Optional[float] = None,
    radius_km: Optional[float] = None,
    query_text: Optional[str] = None,
    status_filter: Optional[str] = "OPEN",
    min_power: Optional[int] = None,
    min_stalls: Optional[int] = None,
    limit: int = 100
) -> List[Dict[str, Any]]:
    """Query and filter superchargers by bounding box, radius, text, status, and specs."""
    chargers = load_superchargers()
    results = []

    text = query_text.strip().lower() if query_text else None

    for c in chargers:
        # Status filter
        if status_filter and status_filter != "ALL":
            if c.get("status") != status_filter:
                continue

        # Power filter
        if min_power and (c.get("power") or 0) < min_power:
            continue

        # Stall count filter
        if min_stalls and (c.get("stalls") or 0) < min_stalls:
            continue

        lat = c["lat"]
        lng = c["lng"]

        # Bounds filter
        if bounds:
            if not (bounds["min_lat"] <= lat <= bounds["max_lat"] and
                    bounds["min_lng"] <= lng <= bounds["max_lng"]):
                continue

        # Radial filter
        if center_lat is not None and center_lng is not None and radius_km is not None:
            dist = haversine_km(center_lat, center_lng, lat, lng)
            if dist > radius_km:
                continue
            c = dict(c)
            c["distance_km"] = round(dist, 1)

        # Text search
        if text:
            name_text = c.get("name", "").lower()
            city_text = c.get("city", "").lower()
            state_text = c.get("state", "").lower()
            country_text = c.get("country", "").lower()
            street_text = c.get("street", "").lower()
            if not (text in name_text or text in city_text or text in state_text or
                    text in country_text or text in street_text):
                continue

        results.append(c)
        if len(results) >= limit and not (center_lat and center_lng):
            break

    if center_lat is not None and center_lng is not None:
        results.sort(key=lambda x: x.get("distance_km", float("inf")))
        return results[:limit]

    return results

def geocode_address(query: str) -> List[Dict[str, Any]]:
    """Geocode an address or place name using Photon (OSM) with Nominatim fallback."""
    # Check if query is raw "lat, lng" coordinates
    parts = [p.strip() for p in query.split(",")]
    if len(parts) == 2:
        try:
            lat = float(parts[0])
            lng = float(parts[1])
            if -90 <= lat <= 90 and -180 <= lng <= 180:
                return [{
                    "name": f"Coordinates ({lat:.4f}, {lng:.4f})",
                    "lat": lat,
                    "lng": lng,
                    "type": "coordinate",
                    "importance": 1.0
                }]
        except ValueError:
            pass

    encoded_q = urllib.parse.quote(query)
    
    # 1. Primary: Photon OSM Geocoding (high reliability, rate limit friendly)
    try:
        url = f"{PHOTON_BASE_URL}/?q={encoded_q}&limit=5"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        features = data.get("features", [])
        if features:
            results = []
            for f in features:
                props = f.get("properties", {})
                coords = f.get("geometry", {}).get("coordinates", [])
                if len(coords) < 2:
                    continue
                name_parts = [props.get("name")]
                if props.get("street"):
                    name_parts.append(props.get("street"))
                if props.get("city") and props.get("city") != props.get("name"):
                    name_parts.append(props.get("city"))
                if props.get("state"):
                    name_parts.append(props.get("state"))
                if props.get("country"):
                    name_parts.append(props.get("country"))
                display_name = ", ".join([p for p in name_parts if p])
                results.append({
                    "name": display_name or props.get("name", query),
                    "lat": float(coords[1]),
                    "lng": float(coords[0]),
                    "type": props.get("type", "place"),
                    "importance": 0.8
                })
            return results
    except Exception as e:
        print(f"Photon geocoding error: {e}")

    # 2. Fallback: Nominatim
    try:
        url = f"{NOMINATIM_BASE_URL}/search?format=json&q={encoded_q}&addressdetails=1&limit=5"
        req = urllib.request.Request(url, headers={"User-Agent": "TeslaSuperchargerApp/1.0 (tester@example.com)"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        results = []
        for item in data:
            results.append({
                "name": item.get("display_name"),
                "lat": float(item.get("lat")),
                "lng": float(item.get("lon")),
                "type": item.get("type"),
                "importance": item.get("importance", 0)
            })
        return results
    except Exception as e:
        print(f"Nominatim geocoding error: {e}")

    return []

def get_osrm_route(coordinates: List[Tuple[float, float]], overview: str = "full") -> Dict[str, Any]:
    """
    Query OSRM driving service.
    coordinates: List of (lng, lat) tuples
    """
    coord_str = ";".join([f"{lng:.6f},{lat:.6f}" for lng, lat in coordinates])
    url = f"{OSRM_BASE_URL}/route/v1/driving/{coord_str}?overview={overview}&geometries=geojson&steps=false"
    
    req = urllib.request.Request(url, headers={"User-Agent": "TeslaSuperchargerApp/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("code") == "Ok" and data.get("routes"):
                return data
    except Exception as e:
        print(f"OSRM routing failed: {e}")
    
    # Fallback: compute straight-line approximation if OSRM is unreachable
    return create_direct_route_fallback(coordinates)

def create_direct_route_fallback(coordinates: List[Tuple[float, float]]) -> Dict[str, Any]:
    """Fallback generator for straight line legs when external network routing is unavailable."""
    total_distance_m = 0.0
    legs = []
    
    for i in range(len(coordinates) - 1):
        lng1, lat1 = coordinates[i]
        lng2, lat2 = coordinates[i + 1]
        dist_km = haversine_km(lat1, lng1, lat2, lng2)
        dist_m = dist_km * 1000.0
        # Assume 85 km/h driving average
        duration_s = (dist_km / 85.0) * 3600.0
        total_distance_m += dist_m
        legs.append({
            "distance": dist_m,
            "duration": duration_s,
            "summary": "Direct segment"
        })
    
    total_duration_s = sum(leg["duration"] for leg in legs)
    
    return {
        "code": "Ok",
        "fallback": True,
        "routes": [{
            "distance": total_distance_m,
            "duration": total_duration_s,
            "geometry": {
                "type": "LineString",
                "coordinates": [[c[0], c[1]] for c in coordinates]
            },
            "legs": legs
        }]
    }

def find_superchargers_along_route(
    coordinates: List[Tuple[float, float]],
    corridor_buffer_km: float = 25.0,
    status_filter: str = "OPEN"
) -> List[Dict[str, Any]]:
    """
    Find all superchargers within corridor_buffer_km along a route geometry.
    coordinates: List of [lng, lat]
    Returns list of chargers with their detour distance and position along route.
    """
    chargers = load_superchargers()
    if not coordinates:
        return []

    # 1. Bounding box filter first for speed
    all_lats = [c[1] for c in coordinates]
    all_lngs = [c[0] for c in coordinates]
    lat_deg_pad = (corridor_buffer_km / 110.574) + 0.1
    lng_deg_pad = (corridor_buffer_km / (111.320 * max(0.2, math.cos(math.radians(sum(all_lats)/len(all_lats)))))) + 0.1

    min_lat = min(all_lats) - lat_deg_pad
    max_lat = max(all_lats) + lat_deg_pad
    min_lng = min(all_lngs) - lng_deg_pad
    max_lng = max(all_lngs) + lng_deg_pad

    candidates = [
        c for c in chargers
        if (min_lat <= c["lat"] <= max_lat and min_lng <= c["lng"] <= max_lng and
            (status_filter == "ALL" or c.get("status") == status_filter))
    ]

    if not candidates:
        return []

    # Pre-calculate cumulative distance along polyline vertices
    cum_distances = [0.0]
    for i in range(len(coordinates) - 1):
        seg_dist = haversine_km(coordinates[i][1], coordinates[i][0],
                                coordinates[i+1][1], coordinates[i+1][0])
        cum_distances.append(cum_distances[-1] + seg_dist)

    total_route_length_km = cum_distances[-1]

    # Sample polyline if too dense to keep computation lightning fast (< 2000 points)
    step = 1
    if len(coordinates) > 1500:
        step = len(coordinates) // 1000 + 1

    sampled_indices = list(range(0, len(coordinates) - 1, step))
    if sampled_indices[-1] != len(coordinates) - 2:
        sampled_indices.append(len(coordinates) - 2)

    along_route = []

    for c in candidates:
        c_lat = c["lat"]
        c_lng = c["lng"]
        min_dist_to_route = float("inf")
        best_progress_km = 0.0

        for idx in sampled_indices:
            idx2 = min(idx + step, len(coordinates) - 1)
            p1_lng, p1_lat = coordinates[idx]
            p2_lng, p2_lat = coordinates[idx2]

            dist, t = distance_point_to_segment_km(c_lng, c_lat, p1_lng, p1_lat, p2_lng, p2_lat)
            if dist < min_dist_to_route:
                min_dist_to_route = dist
                seg_start_dist = cum_distances[idx]
                seg_len = cum_distances[idx2] - cum_distances[idx]
                best_progress_km = seg_start_dist + (t * seg_len)

        if min_dist_to_route <= corridor_buffer_km:
            c_copy = dict(c)
            c_copy["detour_km"] = round(min_dist_to_route, 1)
            c_copy["detour_miles"] = round(min_dist_to_route * 0.621371, 1)
            c_copy["route_progress_km"] = round(best_progress_km, 1)
            c_copy["route_progress_miles"] = round(best_progress_km * 0.621371, 1)
            along_route.append(c_copy)

    # Sort by progress along the route
    along_route.sort(key=lambda x: x["route_progress_km"])
    return along_route

def plan_trip(
    origin: Tuple[float, float],         # (lat, lng)
    destination: Tuple[float, float],    # (lat, lng)
    initial_battery_pct: float = 90.0,
    target_arrival_pct: float = 15.0,
    max_range_km: float = 450.0,         # Typical Tesla long-range ~280-320 miles (~450-510 km)
    corridor_buffer_km: float = 30.0,
    min_power: int = 150                 # Prefer V3/V4 high-speed stalls
) -> Dict[str, Any]:
    """
    Computes direct route, evaluates Supercharger stops needed along the way,
    and calculates multi-stop final route with detailed charging schedules.
    """
    orig_lat, orig_lng = origin
    dest_lat, dest_lng = destination

    # 1. Get initial baseline route from origin to destination
    initial_route_res = get_osrm_route([(orig_lng, orig_lat), (dest_lng, dest_lat)], overview="full")
    if not initial_route_res.get("routes"):
        raise ValueError("Could not find route between origin and destination")

    base_route = initial_route_res["routes"][0]
    base_coords = base_route["geometry"]["coordinates"]  # [[lng, lat], ...]
    total_dist_km = base_route["distance"] / 1000.0
    total_dur_s = base_route["duration"]

    # 2. Find all candidates along corridor
    candidates = find_superchargers_along_route(base_coords, corridor_buffer_km=corridor_buffer_km)

    # Filter to preferred high power chargers, but fall back if none available
    high_power_candidates = [c for c in candidates if (c.get("power") or 0) >= min_power]
    if len(high_power_candidates) >= 2 or len(candidates) <= 2:
        eligible_chargers = high_power_candidates if high_power_candidates else candidates
    else:
        eligible_chargers = candidates

    # 3. Determine if charging is needed
    current_range_km = (initial_battery_pct / 100.0) * max_range_km
    reserve_range_km = (target_arrival_pct / 100.0) * max_range_km
    usable_initial_range_km = current_range_km - reserve_range_km

    selected_stops = []
    
    # If trip distance exceeds current safe range, we must plan charging stops
    if total_dist_km > usable_initial_range_km and eligible_chargers:
        # Greedy simulation with lookahead for optimal stops
        current_km = 0.0
        remaining_battery_km = current_range_km
        simulated_stops = []

        while True:
            # Distance from current point to destination
            dist_to_dest = total_dist_km - current_km
            if remaining_battery_km - dist_to_dest >= reserve_range_km:
                # Can safely reach destination without additional stop!
                break

            # Find reachable chargers ahead before battery drops below reserve_range_km
            max_reachable_km = current_km + (remaining_battery_km - reserve_range_km)
            reachable = [c for c in eligible_chargers if current_km + 30.0 < c["route_progress_km"] <= max_reachable_km]

            if not reachable:
                # Extend search slightly if emergency (allow battery to drop to 8%)
                emergency_reachable_km = current_km + (remaining_battery_km - (0.08 * max_range_km))
                reachable = [c for c in eligible_chargers if current_km + 15.0 < c["route_progress_km"] <= emergency_reachable_km]

            if not reachable:
                # If still nothing, pick closest charger beyond current_km
                future = [c for c in eligible_chargers if c["route_progress_km"] > current_km + 10.0]
                if future:
                    reachable = [future[0]]
                else:
                    # No more chargers ahead
                    break

            # Score reachable chargers:
            # High power (kW), low detour distance, good spacing (further along is better to avoid excessive stops)
            def score_charger(c):
                progress_ratio = (c["route_progress_km"] - current_km) / max_range_km
                power_bonus = (c.get("power", 150) / 250.0) * 1.5
                detour_penalty = (c.get("detour_km", 0) / 10.0) * 2.0
                stalls_bonus = min(2.0, (c.get("stalls", 8) / 12.0))
                return (progress_ratio * 3.5) + power_bonus + stalls_bonus - detour_penalty

            best_charger = max(reachable, key=score_charger)

            # Calculate arrival battery at this charger
            drive_dist_km = best_charger["route_progress_km"] - current_km
            arrival_km = remaining_battery_km - drive_dist_km
            arrival_pct = round(max(5.0, (arrival_km / max_range_km) * 100.0), 1)

            # Determine target charge amount (typically 80% for speed, or enough to reach next/dest)
            target_pct = 80.0
            dist_from_here_to_dest = total_dist_km - best_charger["route_progress_km"]
            if (dist_from_here_to_dest + reserve_range_km) <= (0.75 * max_range_km):
                target_pct = min(80.0, round(((dist_from_here_to_dest + reserve_range_km) / max_range_km) * 100.0 + 10.0, 1))

            pct_to_add = max(10.0, target_pct - arrival_pct)
            # Estimate charging time: 10% to 80% takes ~25-30 min at 250kW, ~40 min at 150kW
            charge_speed_factor = 250.0 / max(100, best_charger.get("power", 150))
            charge_duration_min = round(pct_to_add * 0.42 * charge_speed_factor + 3.0)

            stop_info = dict(best_charger)
            stop_info["arrival_battery_pct"] = arrival_pct
            stop_info["departure_battery_pct"] = target_pct
            stop_info["charge_duration_min"] = charge_duration_min
            simulated_stops.append(stop_info)

            # Update simulation state
            current_km = best_charger["route_progress_km"]
            remaining_battery_km = (target_pct / 100.0) * max_range_km

            # Prevent infinite loops
            if len(simulated_stops) > 15:
                break

        selected_stops = simulated_stops

    # 4. If stops were selected, compute multi-stop routed geometry through all Superchargers
    final_coordinates = [(orig_lng, orig_lat)]
    for stop in selected_stops:
        final_coordinates.append((stop["lng"], stop["lat"]))
    final_coordinates.append((dest_lng, dest_lat))

    if len(final_coordinates) > 2:
        multi_route_res = get_osrm_route(final_coordinates, overview="full")
        if multi_route_res.get("routes"):
            active_route = multi_route_res["routes"][0]
        else:
            active_route = base_route
    else:
        active_route = base_route

    total_route_distance_km = active_route["distance"] / 1000.0
    total_drive_duration_s = active_route["duration"]
    total_charge_duration_min = sum(s.get("charge_duration_min", 0) for s in selected_stops)

    # Format stop list for UI
    stops_summary = []
    # Origin
    stops_summary.append({
        "type": "ORIGIN",
        "name": "Starting Location",
        "lat": orig_lat,
        "lng": orig_lng,
        "battery_pct": initial_battery_pct
    })
    # Supercharger stops
    for idx, stop in enumerate(selected_stops):
        stops_summary.append({
            "type": "SUPERCHARGER",
            "stop_index": idx + 1,
            "id": stop["id"],
            "name": stop["name"],
            "lat": stop["lat"],
            "lng": stop["lng"],
            "power": stop.get("power"),
            "stalls": stop.get("stalls"),
            "arrival_battery_pct": stop.get("arrival_battery_pct"),
            "departure_battery_pct": stop.get("departure_battery_pct"),
            "charge_duration_min": stop.get("charge_duration_min"),
            "street": stop.get("street"),
            "city": stop.get("city"),
            "state": stop.get("state"),
            "detour_miles": stop.get("detour_miles")
        })
    # Destination
    est_final_battery = round(max(5.0, 100.0 - (total_route_distance_km / max_range_km) * 100.0) if not selected_stops else target_arrival_pct, 1)
    stops_summary.append({
        "type": "DESTINATION",
        "name": "Destination",
        "lat": dest_lat,
        "lng": dest_lng,
        "battery_pct": est_final_battery
    })

    return {
        "summary": {
            "distance_km": round(total_route_distance_km, 1),
            "distance_miles": round(total_route_distance_km * 0.621371, 1),
            "drive_duration_seconds": round(total_drive_duration_s),
            "drive_duration_formatted": format_duration(total_drive_duration_s),
            "charge_duration_minutes": total_charge_duration_min,
            "total_trip_duration_formatted": format_duration(total_drive_duration_s + total_charge_duration_min * 60),
            "supercharger_stops_count": len(selected_stops),
            "chargers_along_corridor_count": len(candidates)
        },
        "geometry": active_route["geometry"],
        "stops": stops_summary,
        "all_corridor_chargers": candidates
    }

def format_duration(seconds: float) -> str:
    hrs = int(seconds // 3600)
    mins = int((seconds % 3600) // 60)
    if hrs > 0:
        return f"{hrs} hr {mins} min"
    return f"{mins} min"
