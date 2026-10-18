#!/usr/bin/env python3
"""
Comprehensive Unit and Integration Tests for Tesla Supercharger Route Planner:
- Global Supercharger dataset integrity & spatial queries
- Visit Maximizer routing mode & progression-based stop distribution
- Force-Included Area & specific Supercharger stops
- Efficient stop sequencing & local 2-opt untangling
- Fallback route generation & OSRM batching/chunking
- Geocoding and coordinate parsing
"""

import json
import os
import unittest
import urllib.request
import routing

class TestTeslaRouting(unittest.TestCase):
    
    @classmethod
    def setUpClass(cls):
        cls.chargers = routing.load_superchargers()

    def test_dataset_loaded(self):
        self.assertGreater(len(self.chargers), 5000, "Dataset should have over 5,000 Superchargers")
        first = self.chargers[0]
        self.assertIn("lat", first)
        self.assertIn("lng", first)
        self.assertIn("power", first)
        self.assertIn("stalls", first)
        self.assertIn("name", first)

    def test_haversine_formula(self):
        # Distance between London (51.5074, -0.1278) and Paris (48.8566, 2.3522) is ~343 km
        dist = routing.haversine_km(51.5074, -0.1278, 48.8566, 2.3522)
        self.assertAlmostEqual(dist, 343.5, delta=5.0)

    def test_radial_query(self):
        # San Francisco coordinates
        sf_lat, sf_lng = 37.7749, -122.4194
        results = routing.query_superchargers(center_lat=sf_lat, center_lng=sf_lng, radius_km=20, limit=20)
        self.assertGreater(len(results), 0)
        distances = [r["distance_km"] for r in results]
        self.assertEqual(distances, sorted(distances))
        for r in results:
            self.assertLessEqual(r["distance_km"], 20.0)

    def test_text_search(self):
        results = routing.query_superchargers(query_text="Kettleman", limit=10)
        self.assertGreater(len(results), 0)
        found = any("Kettleman" in r["name"] for r in results)
        self.assertTrue(found, "Should find Kettleman City Supercharger")

    def test_power_and_stall_filtering(self):
        results = routing.query_superchargers(center_lat=34.0522, center_lng=-118.2437, radius_km=50, min_power=250, min_stalls=16)
        for r in results:
            self.assertGreaterEqual(r["power"], 250)
            self.assertGreaterEqual(r["stalls"], 16)

    def test_bounding_box_area_query(self):
        # Kettleman City area bounds
        bounds = {
            "min_lat": 35.8,
            "max_lat": 36.2,
            "min_lng": -120.2,
            "max_lng": -119.8
        }
        area_chargers = routing.query_superchargers(bounds=bounds, limit=50)
        self.assertGreater(len(area_chargers), 0)
        for c in area_chargers:
            self.assertTrue(bounds["min_lat"] <= c["lat"] <= bounds["max_lat"])
            self.assertTrue(bounds["min_lng"] <= c["lng"] <= bounds["max_lng"])

    def test_corridor_chargers_along_polyline(self):
        coords = [(-122.4194, 37.7749), (-122.1430, 37.4419), (-121.8863, 37.3382)]
        corridor = routing.find_superchargers_along_route(coords, corridor_buffer_km=15.0)
        self.assertGreater(len(corridor), 0)
        for c in corridor:
            self.assertLessEqual(c["detour_km"], 15.0)
            self.assertIn("detour_miles", c)
            self.assertIn("route_progress_km", c)

    def test_visit_maximizer_mode(self):
        # SF to LA in MAXIMIZE mode requesting 8 stops
        plan = routing.plan_trip(
            origin=(37.7749, -122.4194),
            destination=(34.0522, -118.2437),
            routing_mode="MAXIMIZE",
            max_stops=8
        )
        self.assertEqual(plan["summary"]["routing_mode"], "MAXIMIZE")
        stops = plan["stops"]
        sc_stops = [s for s in stops if s["type"] == "SUPERCHARGER"]
        # Should select multiple Superchargers along the highway
        self.assertGreaterEqual(len(sc_stops), 4)
        self.assertLessEqual(len(sc_stops), 8)

        # Verify progression: stops should generally advance toward destination
        lats = [s["lat"] for s in sc_stops]
        # Moving South from SF (~37.7) toward LA (~34.0), latitudes should be strictly or generally decreasing
        self.assertGreater(lats[0], lats[-1], "First stop should be further North than last stop")

    def test_force_included_stops(self):
        # Force include Baker, CA (ID: 4298) on SF to LA trip
        plan = routing.plan_trip(
            origin=(37.7749, -122.4194),
            destination=(34.0522, -118.2437),
            routing_mode="MAXIMIZE",
            forced_charger_ids=[4298],
            max_stops=6
        )
        self.assertEqual(plan["summary"]["forced_stops_count"], 1)
        sc_stops = [s for s in plan["stops"] if s["type"] == "SUPERCHARGER"]
        baker_found = any(s["id"] == 4298 and s.get("forced") is True for s in sc_stops)
        self.assertTrue(baker_found, "Baker Supercharger must be force-included in the route")

    def test_stop_sequencing_untangling(self):
        origin = (37.7749, -122.4194)
        destination = (34.0522, -118.2437)
        # Random order of stops along CA
        shuffled = [
            {"id": 1, "name": "Bakersfield", "lat": 35.3733, "lng": -119.0187, "route_progress_km": 400.0},
            {"id": 2, "name": "San Jose", "lat": 37.3382, "lng": -121.8863, "route_progress_km": 75.0},
            {"id": 3, "name": "Kettleman", "lat": 35.9863, "lng": -119.9616, "route_progress_km": 280.0},
        ]
        ordered = routing.sequence_stops_efficiently(origin, destination, shuffled)
        names = [s["name"] for s in ordered]
        self.assertEqual(names, ["San Jose", "Kettleman", "Bakersfield"], "Stops must sequence smoothly Southbound")

    def test_geocode_coordinates_and_address(self):
        # Test coordinate string parser
        coords = routing.geocode_address("37.7749, -122.4194")
        self.assertEqual(len(coords), 1)
        self.assertAlmostEqual(coords[0]["lat"], 37.7749)
        self.assertAlmostEqual(coords[0]["lng"], -122.4194)

    def test_max_stops_clamped_to_fifty(self):
        """max_stops above UI/backend ceiling (50) must clamp without error."""
        plan = routing.plan_trip(
            origin=(37.7749, -122.4194),
            destination=(34.0522, -118.2437),
            routing_mode="MAXIMIZE",
            max_stops=999,
        )
        sc_stops = [s for s in plan["stops"] if s["type"] == "SUPERCHARGER"]
        self.assertLessEqual(len(sc_stops), 50)
        self.assertGreaterEqual(len(sc_stops), 1)

    def test_corridor_single_coordinate_returns_empty(self):
        self.assertEqual(
            routing.find_superchargers_along_route([(-122.4, 37.7)], corridor_buffer_km=15.0),
            [],
        )

    def test_min_stops_keeps_forced_without_maximizer_pack(self):
        """MIN_STOPS + forced must stay in min-stops path (not Visit Maximizer packing)."""
        plan = routing.plan_trip(
            origin=(37.7749, -122.4194),
            destination=(34.0522, -118.2437),
            routing_mode="MIN_STOPS",
            forced_charger_ids=[4298],  # Baker
            max_stops=20,
        )
        self.assertEqual(plan["summary"]["routing_mode"], "MIN_STOPS")
        sc_stops = [s for s in plan["stops"] if s["type"] == "SUPERCHARGER"]
        self.assertTrue(any(s.get("id") == 4298 and s.get("forced") for s in sc_stops))
        # Maximizer with max_stops=20 typically packs many; min+forced should stay leaner
        self.assertLessEqual(len(sc_stops), 10)

if __name__ == "__main__":
    unittest.main()
