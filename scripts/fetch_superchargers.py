#!/usr/bin/env python3
"""
Fetch, validate, and minify Tesla Supercharger dataset from supercharge.info / open data sources.
Outputs clean JSON to data/superchargers.json.
"""

import json
import os
import sys
import urllib.request

SOURCE_URL = "https://supercharge.info/service/supercharge/allSites"
OUTPUT_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "superchargers.json")

def fetch_and_process():
    print(f"Fetching Supercharger data from {SOURCE_URL}...")
    req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "TeslaRoutePlanner/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw_data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"Error fetching live data: {e}")
        if os.path.exists(OUTPUT_PATH):
            print(f"Using existing data at {OUTPUT_PATH}")
            return
        raise

    print(f"Raw sites received: {len(raw_data)}")
    
    cleaned = []
    for site in raw_data:
        gps = site.get("gps") or {}
        lat = gps.get("latitude")
        lng = gps.get("longitude")
        if lat is None or lng is None:
            continue
        
        addr = site.get("address") or {}
        stalls = site.get("stalls") or {}
        plugs = site.get("plugs") or {}
        
        cleaned.append({
            "id": site.get("id"),
            "name": site.get("name") or "Tesla Supercharger",
            "status": site.get("status") or "OPEN",
            "lat": round(float(lat), 6),
            "lng": round(float(lng), 6),
            "stalls": int(site.get("stallCount") or 0),
            "power": int(site.get("powerKilowatt") or 0),
            "street": addr.get("street") or "",
            "city": addr.get("city") or "",
            "state": addr.get("state") or "",
            "zip": addr.get("zip") or "",
            "country": addr.get("country") or "",
            "region": addr.get("region") or "",
            "facility": site.get("facilityName") or "",
            "otherEVs": bool(site.get("otherEVs")),
            "solar": bool(site.get("solarCanopy")),
            "battery": bool(site.get("battery")),
            "stallTypes": stalls,
            "plugTypes": plugs,
            "elevation": site.get("elevationMeters"),
            "dateOpened": site.get("dateOpened") or "",
        })
    
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(cleaned, f, separators=(",", ":"))
    
    file_size_mb = os.path.getsize(OUTPUT_PATH) / (1024 * 1024)
    print(f"Successfully saved {len(cleaned)} superchargers to {OUTPUT_PATH} ({file_size_mb:.2f} MB)")

if __name__ == "__main__":
    fetch_and_process()
