#!/usr/bin/env python3
"""
Tesla Supercharger Route Planner - Web Application & API Server.
Zero extra third-party dependencies: Built with Python's high performance standard library.
"""

import http.server
import json
import mimetypes
import os
import socketserver
import sys
import urllib.parse
from typing import Any, Dict

import routing

PORT = int(os.environ.get("PORT", 8080))
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

class SuperchargerRequestHandler(http.server.SimpleHTTPRequestHandler):
    """Handles static files and REST API endpoints for Tesla Supercharger planning."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # API Endpoints
        if path == "/api/superchargers":
            self.handle_get_superchargers(query)
            return
        elif path == "/api/geocode":
            self.handle_geocode(query)
            return
        elif path == "/api/stats":
            self.handle_stats()
            return
        elif path == "/api/health":
            self.send_json_response({"status": "healthy", "service": "Tesla Supercharger Route Planner"})
            return

        # Default fallback to index.html for single page app root
        if path == "/" or not os.path.exists(os.path.join(STATIC_DIR, path.lstrip("/"))):
            self.path = "/index.html"

        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/plan-route":
            self.handle_plan_route()
            return
        elif path == "/api/find-along-route":
            self.handle_find_along_route()
            return

        self.send_error(404, "Endpoint not found")

    def handle_get_superchargers(self, query: Dict[str, list]):
        """Filter superchargers by bounds, search text, or radius."""
        try:
            status = query.get("status", ["OPEN"])[0]
            limit = int(query.get("limit", [150])[0])
            min_power = int(query.get("min_power", [0])[0]) if "min_power" in query else None
            min_stalls = int(query.get("min_stalls", [0])[0]) if "min_stalls" in query else None
            query_text = query.get("q", [None])[0]

            bounds = None
            if "min_lat" in query and "max_lat" in query and "min_lng" in query and "max_lng" in query:
                bounds = {
                    "min_lat": float(query["min_lat"][0]),
                    "max_lat": float(query["max_lat"][0]),
                    "min_lng": float(query["min_lng"][0]),
                    "max_lng": float(query["max_lng"][0])
                }

            center_lat = float(query["lat"][0]) if "lat" in query else None
            center_lng = float(query["lng"][0]) if "lng" in query else None
            radius_km = float(query["radius_km"][0]) if "radius_km" in query else None

            results = routing.query_superchargers(
                bounds=bounds,
                center_lat=center_lat,
                center_lng=center_lng,
                radius_km=radius_km,
                query_text=query_text,
                status_filter=status,
                min_power=min_power,
                min_stalls=min_stalls,
                limit=limit
            )

            self.send_json_response({
                "count": len(results),
                "superchargers": results
            })
        except Exception as e:
            self.send_json_response({"error": str(e)}, status=400)

    def handle_geocode(self, query: Dict[str, list]):
        """Geocode query string to GPS coordinates."""
        q = query.get("q", [""])[0].strip()
        if not q:
            self.send_json_response({"results": []})
            return

        try:
            results = routing.geocode_address(q)
            self.send_json_response({"results": results})
        except Exception as e:
            self.send_json_response({"error": f"Geocoding failed: {e}", "results": []}, status=500)

    def handle_stats(self):
        """Return dataset statistics."""
        chargers = routing.load_superchargers()
        open_count = sum(1 for c in chargers if c.get("status") == "OPEN")
        powers = [c.get("power", 0) for c in chargers if c.get("power")]
        max_power = max(powers) if powers else 0
        countries = len(set(c.get("country") for c in chargers if c.get("country")))
        
        self.send_json_response({
            "total_superchargers": len(chargers),
            "open_superchargers": open_count,
            "max_power_kw": max_power,
            "countries_covered": countries
        })

    def handle_plan_route(self):
        """Calculate optimal route and charging stops."""
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8")
            data = json.loads(body)

            origin = data.get("origin")          # [lat, lng]
            destination = data.get("destination") # [lat, lng]
            if not origin or not destination:
                self.send_json_response({"error": "Missing origin or destination coordinates"}, status=400)
                return

            initial_battery = float(data.get("initial_battery", 90.0))
            target_arrival = float(data.get("target_arrival", 15.0))
            max_range = float(data.get("max_range_km", 450.0))
            corridor_buffer = float(data.get("corridor_buffer_km", 30.0))
            min_power = int(data.get("min_power", 150))

            plan = routing.plan_trip(
                origin=(float(origin[0]), float(origin[1])),
                destination=(float(destination[0]), float(destination[1])),
                initial_battery_pct=initial_battery,
                target_arrival_pct=target_arrival,
                max_range_km=max_range,
                corridor_buffer_km=corridor_buffer,
                min_power=min_power
            )

            self.send_json_response(plan)
        except Exception as e:
            import traceback
            traceback.print_exc()
            self.send_json_response({"error": str(e)}, status=500)

    def handle_find_along_route(self):
        """Find chargers along provided GeoJSON or coordinate list."""
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8")
            data = json.loads(body)

            coords = data.get("coordinates") # List of [lng, lat]
            buffer_km = float(data.get("buffer_km", 25.0))
            status = data.get("status", "OPEN")

            if not coords:
                self.send_json_response({"error": "No coordinates provided"}, status=400)
                return

            chargers = routing.find_superchargers_along_route(coords, corridor_buffer_km=buffer_km, status_filter=status)
            self.send_json_response({
                "count": len(chargers),
                "superchargers": chargers
            })
        except Exception as e:
            self.send_json_response({"error": str(e)}, status=500)

    def send_json_response(self, data: Any, status: int = 200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # Disable cache for rapid dev
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

def run_server(port: int = PORT):
    # Pre-load dataset
    routing.load_superchargers()
    
    class ReusableTCPServer(socketserver.TCPServer):
        allow_reuse_address = True

    with ReusableTCPServer(("", port), SuperchargerRequestHandler) as httpd:
        print(f"============================================================")
        print(f"  Tesla Supercharger Route Planner running on port {port}")
        print(f"  Open http://localhost:{port} in your browser")
        print(f"============================================================")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")

if __name__ == "__main__":
    port_arg = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    run_server(port_arg)
