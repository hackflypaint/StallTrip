"""
Tesla Supercharger Routing and Recommendation Engine.
Features:
- Global Supercharger spatial queries & corridor filtering
- Visit Maximizer mode: visits as many Superchargers along the route as possible in an efficient sensible sequence
- Force-Included Area & Specific Charger Stops: user can select an area on the map or pick individual chargers to guarantee inclusion
- Minimum-stops EV range optimizer mode (for fastest trip)
- OSRM multi-stop driving route generation with automatic batching/chunking and offline direct fallbacks
- Dual geocoding pipeline (Photon OSM + direct coordinates + Nominatim fallback)
"""

import json
import math
import os
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Set, Tuple

DATA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "superchargers.json")
OSRM_BASE_URL = "http://router.project-osrm.org"
PHOTON_BASE_URL = "https://photon.komoot.io/api"
NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org"

# In-memory store of all Superchargers
SUPERCHARGERS: List[Dict[str, Any]] = []
SUPERCHARGERS_BY_ID: Dict[int, Dict[str, Any]] = {}

def load_superchargers() -> List[Dict[str, Any]]:
    global SUPERCHARGERS, SUPERCHARGERS_BY_ID
    if SUPERCHARGERS:
        return SUPERCHARGERS
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            SUPERCHARGERS = json.load(f)
            SUPERCHARGERS_BY_ID = {c["id"]: c for c in SUPERCHARGERS if "id" in c}
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
    limit: int = 150
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
    
    # 1. Primary: Photon OSM Geocoding
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
    """Single OSRM driving route request."""
    coord_str = ";".join([f"{lng:.6f},{lat:.6f}" for lng, lat in coordinates])
    url = f"{OSRM_BASE_URL}/route/v1/driving/{coord_str}?overview={overview}&geometries=geojson&steps=false"
    
    req = urllib.request.Request(url, headers={"User-Agent": "TeslaSuperchargerApp/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("code") == "Ok" and data.get("routes"):
                return data
    except Exception as e:
        print(f"OSRM single call failed: {e}")
    
    return create_direct_route_fallback(coordinates)

def get_chunked_osrm_route(coordinates: List[Tuple[float, float]], chunk_size: int = 18) -> Dict[str, Any]:
    """
    Query OSRM driving service with automatic batching/chunking to support large numbers
    of Supercharger stops without URL length or gateway limitations.
    Stitches coordinates and legs into a continuous route.
    """
    if len(coordinates) <= chunk_size:
        return get_osrm_route(coordinates)

    total_dist_m = 0.0
    total_dur_s = 0.0
    combined_coords = []
    combined_legs = []

    for i in range(0, len(coordinates) - 1, chunk_size - 1):
        chunk = coordinates[i : min(i + chunk_size, len(coordinates))]
        if len(chunk) < 2:
            break
        res = get_osrm_route(chunk, overview="full")
        if res.get("code") == "Ok" and res.get("routes"):
            route = res["routes"][0]
            total_dist_m += route["distance"]
            total_dur_s += route["duration"]
            chunk_coords = route["geometry"]["coordinates"]
            if combined_coords:
                combined_coords.extend(chunk_coords[1:])
            else:
                combined_coords.extend(chunk_coords)
            combined_legs.extend(route.get("legs", []))
        else:
            # Fall back to direct legs for this portion
            direct = create_direct_route_fallback(chunk)
            r = direct["routes"][0]
            total_dist_m += r["distance"]
            total_dur_s += r["duration"]
            chunk_coords = r["geometry"]["coordinates"]
            if combined_coords:
                combined_coords.extend(chunk_coords[1:])
            else:
                combined_coords.extend(chunk_coords)
            combined_legs.extend(r.get("legs", []))

    return {
        "code": "Ok",
        "routes": [{
            "distance": total_dist_m,
            "duration": total_dur_s,
            "geometry": {
                "type": "LineString",
                "coordinates": combined_coords
            },
            "legs": combined_legs
        }]
    }

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
    Returns list of chargers with their detour distance and progress along route.
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

    # Sample polyline if dense (< 1500 vertices)
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

def sequence_stops_efficiently(
    origin: Tuple[float, float],
    destination: Tuple[float, float],
    stops: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """
    Orders a list of Supercharger stops to form a sensible, efficient driving path
    from origin to destination without unnecessary backtracking.
    Uses route progress projection with local 2-opt untangling.
    """
    if len(stops) <= 1:
        return list(stops)

    orig_lat, orig_lng = origin
    dest_lat, dest_lng = destination

    # Calculate progression scalar for each stop relative to origin->destination axis
    v_x = dest_lng - orig_lng
    v_y = dest_lat - orig_lat
    v_len_sq = v_x * v_x + v_y * v_y
    if v_len_sq == 0:
        v_len_sq = 1e-6

    def get_progress(s):
        if "route_progress_km" in s:
            return s["route_progress_km"]
        # Project onto baseline vector
        p_x = s["lng"] - orig_lng
        p_y = s["lat"] - orig_lat
        proj = (p_x * v_x + p_y * v_y) / v_len_sq
        return proj * 1000.0

    ordered = sorted(stops, key=get_progress)

    # Local 2-opt swap pass to eliminate any path crossings
    points = [(orig_lat, orig_lng)] + [(s["lat"], s["lng"]) for s in ordered] + [(dest_lat, dest_lng)]
    improved = True
    iterations = 0

    while improved and iterations < 15:
        improved = False
        iterations += 1
        for i in range(1, len(ordered)):
            for j in range(i + 1, min(i + 4, len(ordered) + 1)):
                # Distance before swap
                p_prev = points[i - 1]
                p_i = points[i]
                p_j = points[j]
                p_next = points[j + 1]

                d_current = (haversine_km(p_prev[0], p_prev[1], p_i[0], p_i[1]) +
                             haversine_km(p_j[0], p_j[1], p_next[0], p_next[1]))
                d_reversed = (haversine_km(p_prev[0], p_prev[1], p_j[0], p_j[1]) +
                              haversine_km(p_i[0], p_i[1], p_next[0], p_next[1]))

                if d_reversed < d_current - 0.5:
                    ordered[i - 1 : j] = reversed(ordered[i - 1 : j])
                    points = [(orig_lat, orig_lng)] + [(s["lat"], s["lng"]) for s in ordered] + [(dest_lat, dest_lng)]
                    improved = True
                    break
            if improved:
                break

    return ordered

def select_maximizer_stops(
    candidates: List[Dict[str, Any]],
    forced_stops: List[Dict[str, Any]],
    origin: Tuple[float, float],
    destination: Tuple[float, float],
    max_stops: int = 15,
    min_spacing_km: float = 12.0
) -> List[Dict[str, Any]]:
    """
    Selects as many Superchargers as possible along the route corridor while keeping
    an efficient, sensible path without zigzagging.
    1. ALL forced_stops (user-selected or area-selected) are 100% guaranteed included.
    2. Additional corridor Superchargers are distributed along highway progression stages
       to span the journey, prioritizing high-speed stations (250kW+) with minimal detours.
    """
    selected_dict: Dict[int, Dict[str, Any]] = {}

    # 1. Add all forced stops first (100% guaranteed)
    for s in forced_stops:
        s_copy = dict(s)
        s_copy["forced"] = True
        s_id = s.get("id") or hash((s["lat"], s["lng"]))
        selected_dict[s_id] = s_copy

    if not candidates:
        return sequence_stops_efficiently(origin, destination, list(selected_dict.values()))

    # Calculate total progress span
    sorted_candidates = sorted(candidates, key=lambda c: c.get("route_progress_km", 0.0))
    min_prog = sorted_candidates[0].get("route_progress_km", 0.0)
    max_prog = sorted_candidates[-1].get("route_progress_km", 100.0)
    total_span = max(10.0, max_prog - min_prog)

    # Number of corridor slots available after forced stops
    remaining_slots = max(0, max_stops - len(selected_dict))
    
    if remaining_slots > 0:
        # Distribute targets across journey milestones
        interval = total_span / (remaining_slots + 1)
        for i in range(1, remaining_slots + 1):
            target_km = min_prog + i * interval
            # Pool of candidates near target milestone (within interval * 0.8)
            nearby = [
                c for c in sorted_candidates
                if abs(c.get("route_progress_km", 0.0) - target_km) <= max(15.0, interval * 0.85)
            ]
            if not nearby:
                # Expand search
                nearby = [
                    c for c in sorted_candidates
                    if abs(c.get("route_progress_km", 0.0) - target_km) <= max(35.0, interval * 1.5)
                ]

            if nearby:
                # Score candidate: prefer minimal detour, high power (kW), and healthy stall count
                def score_cand(c):
                    detour_penalty = (c.get("detour_km", 0.0) * 2.5)
                    power_bonus = (c.get("power", 150) / 50.0)
                    stalls_bonus = min(2.0, c.get("stalls", 8) / 8.0)
                    return detour_penalty - power_bonus - stalls_bonus

                best = min(nearby, key=score_cand)
                c_id = best.get("id") or hash((best["lat"], best["lng"]))

                # Check spacing against already selected stops
                too_close = False
                for s in selected_dict.values():
                    dist = haversine_km(best["lat"], best["lng"], s["lat"], s["lng"])
                    if dist < min_spacing_km:
                        too_close = True
                        break

                if not too_close and c_id not in selected_dict:
                    b_copy = dict(best)
                    b_copy["forced"] = False
                    selected_dict[c_id] = b_copy

    final_stops = list(selected_dict.values())
    return sequence_stops_efficiently(origin, destination, final_stops)

def select_min_stops_for_range(
    eligible_chargers: List[Dict[str, Any]],
    forced_stops: List[Dict[str, Any]],
    origin: Tuple[float, float],
    destination: Tuple[float, float],
    total_dist_km: float,
    initial_battery_pct: float,
    target_arrival_pct: float,
    max_range_km: float
) -> List[Dict[str, Any]]:
    """
    Selects minimum number of Superchargers strictly required to satisfy EV battery range constraints,
    while also ensuring any user-forced stops are included.
    """
    current_range_km = (initial_battery_pct / 100.0) * max_range_km
    reserve_range_km = (target_arrival_pct / 100.0) * max_range_km
    usable_initial_range_km = current_range_km - reserve_range_km

    # If forced stops exist, include them and sequence
    if forced_stops:
        all_stops = list(forced_stops)
        # Check if additional range stops are needed between forced stops
        # For simplicity in min_stops mode with forced stops:
        return sequence_stops_efficiently(origin, destination, all_stops)

    if total_dist_km <= usable_initial_range_km:
        return []

    current_km = 0.0
    remaining_battery_km = current_range_km
    simulated_stops = []

    while True:
        dist_to_dest = total_dist_km - current_km
        if remaining_battery_km - dist_to_dest >= reserve_range_km:
            break

        max_reachable_km = current_km + (remaining_battery_km - reserve_range_km)
        reachable = [c for c in eligible_chargers if current_km + 30.0 < c.get("route_progress_km", 0) <= max_reachable_km]

        if not reachable:
            emergency_reachable_km = current_km + (remaining_battery_km - (0.08 * max_range_km))
            reachable = [c for c in eligible_chargers if current_km + 15.0 < c.get("route_progress_km", 0) <= emergency_reachable_km]

        if not reachable:
            future = [c for c in eligible_chargers if c.get("route_progress_km", 0) > current_km + 10.0]
            if future:
                reachable = [future[0]]
            else:
                break

        def score_charger(c):
            progress_ratio = (c.get("route_progress_km", 0) - current_km) / max_range_km
            power_bonus = (c.get("power", 150) / 250.0) * 1.5
            detour_penalty = (c.get("detour_km", 0) / 10.0) * 2.0
            stalls_bonus = min(2.0, (c.get("stalls", 8) / 12.0))
            return (progress_ratio * 3.5) + power_bonus + stalls_bonus - detour_penalty

        best_charger = max(reachable, key=score_charger)
        simulated_stops.append(dict(best_charger))

        current_km = best_charger.get("route_progress_km", current_km + 200)
        remaining_battery_km = (0.80) * max_range_km

        if len(simulated_stops) > 15:
            break

    return simulated_stops

def plan_trip(
    origin: Tuple[float, float],         # (lat, lng)
    destination: Tuple[float, float],    # (lat, lng)
    routing_mode: str = "MAXIMIZE",      # "MAXIMIZE" (Visit Maximizer) or "MIN_STOPS"
    forced_chargers: Optional[List[Dict[str, Any]]] = None,
    forced_charger_ids: Optional[List[int]] = None,
    max_stops: int = 20,
    initial_battery_pct: float = 90.0,
    target_arrival_pct: float = 15.0,
    max_range_km: float = 450.0,
    corridor_buffer_km: float = 30.0,
    min_power: int = 0
) -> Dict[str, Any]:
    """
    Computes direct route, evaluates Superchargers along the corridor and area,
    sequences stops (maximizing visits by default or minimizing for speed),
    and generates continuous routed geometry through all Superchargers.
    """
    load_superchargers()
    orig_lat, orig_lng = origin
    dest_lat, dest_lng = destination

    # 1. Resolve forced chargers from IDs or objects
    resolved_forced: List[Dict[str, Any]] = []
    if forced_chargers:
        for fc in forced_chargers:
            if isinstance(fc, dict) and "lat" in fc and "lng" in fc:
                resolved_forced.append(fc)

    if forced_charger_ids:
        for cid in forced_charger_ids:
            if cid in SUPERCHARGERS_BY_ID and SUPERCHARGERS_BY_ID[cid] not in resolved_forced:
                resolved_forced.append(SUPERCHARGERS_BY_ID[cid])

    # 2. Baseline direct route
    initial_route_res = get_osrm_route([(orig_lng, orig_lat), (dest_lng, dest_lat)], overview="full")
    if not initial_route_res.get("routes"):
        raise ValueError("Could not find route between origin and destination")

    base_route = initial_route_res["routes"][0]
    base_coords = base_route["geometry"]["coordinates"]  # [[lng, lat], ...]
    total_dist_km = base_route["distance"] / 1000.0

    # 3. Find candidate Superchargers along the corridor
    corridor_chargers = find_superchargers_along_route(base_coords, corridor_buffer_km=corridor_buffer_km)
    
    # Filter by minimum power if requested
    if min_power > 0:
        power_filtered = [c for c in corridor_chargers if (c.get("power") or 0) >= min_power]
        candidate_pool = power_filtered if len(power_filtered) >= 3 else corridor_chargers
    else:
        candidate_pool = corridor_chargers

    # 4. Stop Selection based on Routing Mode
    if routing_mode.upper() == "MIN_STOPS" and not resolved_forced:
        raw_stops = select_min_stops_for_range(
            eligible_chargers=candidate_pool,
            forced_stops=resolved_forced,
            origin=origin,
            destination=destination,
            total_dist_km=total_dist_km,
            initial_battery_pct=initial_battery_pct,
            target_arrival_pct=target_arrival_pct,
            max_range_km=max_range_km
        )
    else:
        # Default: VISIT MAXIMIZER
        raw_stops = select_maximizer_stops(
            candidates=candidate_pool,
            forced_stops=resolved_forced,
            origin=origin,
            destination=destination,
            max_stops=max_stops,
            min_spacing_km=10.0
        )

    # 5. Simulate battery charge and timing at each stop
    current_battery_km = (initial_battery_pct / 100.0) * max_range_km
    curr_point = (orig_lat, orig_lng)
    detailed_stops = []

    for idx, stop in enumerate(raw_stops):
        leg_dist = haversine_km(curr_point[0], curr_point[1], stop["lat"], stop["lng"])
        current_battery_km = max(0.05 * max_range_km, current_battery_km - leg_dist)
        arrival_pct = round((current_battery_km / max_range_km) * 100.0, 1)

        # In Visit Maximizer mode, quick top-ups (e.g. up to 75-80% or +15-20 min visit)
        target_pct = min(85.0, max(arrival_pct + 15.0, 75.0))
        pct_to_add = max(10.0, target_pct - arrival_pct)
        charge_speed = max(100, stop.get("power", 150))
        charge_duration_min = round(pct_to_add * 0.38 * (250.0 / charge_speed) + 4.0)

        current_battery_km = (target_pct / 100.0) * max_range_km
        curr_point = (stop["lat"], stop["lng"])

        s_copy = dict(stop)
        s_copy["stop_index"] = idx + 1
        s_copy["arrival_battery_pct"] = arrival_pct
        s_copy["departure_battery_pct"] = target_pct
        s_copy["charge_duration_min"] = charge_duration_min
        detailed_stops.append(s_copy)

    # 6. Compute multi-stop routed driving geometry with automatic chunking
    final_coordinates = [(orig_lng, orig_lat)]
    for stop in detailed_stops:
        final_coordinates.append((stop["lng"], stop["lat"]))
    final_coordinates.append((dest_lng, dest_lat))

    if len(final_coordinates) > 2:
        multi_route_res = get_chunked_osrm_route(final_coordinates)
        if multi_route_res.get("routes"):
            active_route = multi_route_res["routes"][0]
        else:
            active_route = base_route
    else:
        active_route = base_route

    total_route_distance_km = active_route["distance"] / 1000.0
    total_drive_duration_s = active_route["duration"]
    total_charge_duration_min = sum(s.get("charge_duration_min", 0) for s in detailed_stops)

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
    for s in detailed_stops:
        stops_summary.append({
            "type": "SUPERCHARGER",
            "stop_index": s["stop_index"],
            "id": s.get("id"),
            "name": s["name"],
            "lat": s["lat"],
            "lng": s["lng"],
            "power": s.get("power"),
            "stalls": s.get("stalls"),
            "arrival_battery_pct": s.get("arrival_battery_pct"),
            "departure_battery_pct": s.get("departure_battery_pct"),
            "charge_duration_min": s.get("charge_duration_min"),
            "street": s.get("street"),
            "city": s.get("city"),
            "state": s.get("state"),
            "detour_miles": s.get("detour_miles", 0.1),
            "forced": s.get("forced", False)
        })
    # Destination
    last_leg_dist = haversine_km(curr_point[0], curr_point[1], dest_lat, dest_lng)
    dest_battery_pct = round(max(5.0, ((current_battery_km - last_leg_dist) / max_range_km) * 100.0), 1)
    stops_summary.append({
        "type": "DESTINATION",
        "name": "Destination",
        "lat": dest_lat,
        "lng": dest_lng,
        "battery_pct": dest_battery_pct
    })

    return {
        "summary": {
            "routing_mode": routing_mode.upper(),
            "distance_km": round(total_route_distance_km, 1),
            "distance_miles": round(total_route_distance_km * 0.621371, 1),
            "drive_duration_seconds": round(total_drive_duration_s),
            "drive_duration_formatted": format_duration(total_drive_duration_s),
            "charge_duration_minutes": total_charge_duration_min,
            "total_trip_duration_formatted": format_duration(total_drive_duration_s + total_charge_duration_min * 60),
            "supercharger_stops_count": len(detailed_stops),
            "forced_stops_count": sum(1 for s in detailed_stops if s.get("forced")),
            "chargers_along_corridor_count": len(corridor_chargers)
        },
        "geometry": active_route["geometry"],
        "stops": stops_summary,
        "all_corridor_chargers": corridor_chargers
    }

def format_duration(seconds: float) -> str:
    hrs = int(seconds // 3600)
    mins = int((seconds % 3600) // 60)
    if hrs > 0:
        return f"{hrs} hr {mins} min"
    return f"{mins} min"
