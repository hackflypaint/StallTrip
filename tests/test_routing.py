#!/usr/bin/env python3
"""
Unit and integration tests for Tesla Supercharger routing, spatial query, and API logic.
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
        # Verify distance ordering
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

    def test_corridor_chargers_along_polyline(self):
        # Straight line from SF to San Jose
        coords = [(-122.4194, 37.7749), (-122.1430, 37.4419), (-121.8863, 37.3382)]
        corridor = routing.find_superchargers_along_route(coords, corridor_buffer_km=15.0)
        self.assertGreater(len(corridor), 0)
        for c in corridor:
            self.assertLessEqual(c["detour_km"], 15.0)
            self.assertIn("detour_miles", c)
            self.assertIn("route_progress_km", c)

    def test_plan_trip_sf_to_la(self):
        # SF to LA (~615 km) should require charging stops for a vehicle with 420km range
        plan = routing.plan_trip(
            origin=(37.7749, -122.4194),
            destination=(34.0522, -118.2437),
            initial_battery_pct=90.0,
            target_arrival_pct=15.0,
            max_range_km=420.0,
            corridor_buffer_km=25.0
        )
        self.assertIn("summary", plan)
        self.assertIn("stops", plan)
        self.assertIn("geometry", plan)
        self.assertGreater(plan["summary"]["distance_km"], 500)
        self.assertGreaterEqual(plan["summary"]["supercharger_stops_count"], 1)

        # Check stops structure
        stops = plan["stops"]
        self.assertEqual(stops[0]["type"], "ORIGIN")
        self.assertEqual(stops[-1]["type"], "DESTINATION")
        superchargers = [s for s in stops if s["type"] == "SUPERCHARGER"]
        self.assertGreaterEqual(len(superchargers), 1)
        for sc in superchargers:
            self.assertGreater(sc["charge_duration_min"], 0)
            self.assertGreater(sc["departure_battery_pct"], sc["arrival_battery_pct"])

if __name__ == "__main__":
    unittest.main()
