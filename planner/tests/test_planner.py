import pytest, math
from app.main import (
    haversine, bearing, build_graph,
    dijkstra, astar, nearest_neighbor_tsp,
    Waypoint, PlanRequest, plan_route
)

@pytest.fixture
def boston():    return Waypoint(lat=42.3601, lng=-71.0589, altitude=80, label="Boston")
@pytest.fixture
def cambridge(): return Waypoint(lat=42.3736, lng=-71.1097, altitude=60, label="Cambridge")
@pytest.fixture
def quincy():    return Waypoint(lat=42.2529, lng=-71.0023, altitude=50, label="Quincy")
@pytest.fixture
def three_wps(boston, cambridge, quincy): return [boston, cambridge, quincy]
@pytest.fixture
def simple_graph():
    wps = [Waypoint(lat=0.0,lng=0.0), Waypoint(lat=0.1,lng=0.0), Waypoint(lat=0.1,lng=0.1)]
    return build_graph(wps), wps

class TestHaversine:
    def test_same_point_zero(self):           assert haversine(42.36,-71.05,42.36,-71.05) == 0.0
    def test_boston_cambridge_range(self):    assert 4.0 < haversine(42.3601,-71.0589,42.3736,-71.1097) < 7.0
    def test_symmetry(self):
        assert abs(haversine(42.36,-71.05,40.71,-74.00) - haversine(40.71,-74.00,42.36,-71.05)) < 0.001
    def test_positive(self):                  assert haversine(0,0,1,1) > 0
    def test_equatorial_degree_111km(self):   assert 110 < haversine(0,0,0,1) < 112
    def test_small_distance(self):            assert haversine(42.3601,-71.0589,42.3602,-71.0590) < 0.02
    def test_returns_float(self):             assert isinstance(haversine(0,0,1,1), float)
    def test_pole_to_pole(self):              assert abs(haversine(90,0,-90,0) - 20015) < 100

class TestBearing:
    def test_north(self):  assert abs(bearing(0,0,1,0)   - 0)   < 1
    def test_east(self):   assert abs(bearing(0,0,0,1)   - 90)  < 1
    def test_south(self):  assert abs(bearing(1,0,0,0)   - 180) < 1
    def test_west(self):   assert abs(bearing(0,1,0,0)   - 270) < 1
    def test_range(self):  assert 0 <= bearing(42,-71,40,-74) < 360

class TestGraph:
    def test_node_count(self, three_wps):     assert len(build_graph(three_wps)) == 3
    def test_no_self_loops(self, three_wps):
        g = build_graph(three_wps)
        for node, edges in g.items(): assert node not in [e[1] for e in edges]
    def test_fully_connected(self, three_wps):
        g = build_graph(three_wps)
        for node, edges in g.items(): assert len(edges) == 2
    def test_positive_weights(self, three_wps):
        for _, edges in build_graph(three_wps).items():
            for cost, _ in edges: assert cost > 0
    def test_two_nodes(self, boston, cambridge):
        g = build_graph([boston, cambridge])
        assert len(g[0]) == 1

class TestDijkstra:
    def test_starts_at_source(self, simple_graph):  assert dijkstra(simple_graph[0],0,2)[0] == 0
    def test_ends_at_dest(self, simple_graph):       assert dijkstra(simple_graph[0],0,2)[-1] == 2
    def test_returns_list(self, simple_graph):       assert isinstance(dijkstra(simple_graph[0],0,1), list)
    def test_min_length_2(self, simple_graph):       assert len(dijkstra(simple_graph[0],0,2)) >= 2
    def test_direct_two_nodes(self, simple_graph):   assert dijkstra(simple_graph[0],0,1)[-1] == 1

class TestAStar:
    def test_ends_at_dest(self, simple_graph):
        g, wps = simple_graph
        assert astar(g, wps, 0, 2)[-1] == 2
    def test_matches_dijkstra(self, simple_graph):
        g, wps = simple_graph
        assert dijkstra(g,0,2)[-1] == astar(g,wps,0,2)[-1]
    def test_returns_list(self, simple_graph):
        g, wps = simple_graph
        assert isinstance(astar(g,wps,0,1), list)
    def test_starts_at_source(self, simple_graph):
        g, wps = simple_graph
        assert astar(g,wps,0,2)[0] == 0

class TestTSP:
    def test_all_indices(self, three_wps):   assert sorted(nearest_neighbor_tsp(three_wps)) == [0,1,2]
    def test_starts_zero(self, three_wps):   assert nearest_neighbor_tsp(three_wps)[0] == 0
    def test_two_passthrough(self, boston, cambridge):
        assert nearest_neighbor_tsp([boston,cambridge]) == [0,1]
    def test_no_duplicates(self, three_wps):
        o = nearest_neighbor_tsp(three_wps); assert len(o) == len(set(o))

class TestAPI:
    def test_astar_plan(self, three_wps):
        r = plan_route(PlanRequest(waypoints=three_wps, algorithm="astar"))
        assert r.total_distance_km > 0
    def test_dijkstra_plan(self, three_wps):
        r = plan_route(PlanRequest(waypoints=three_wps, algorithm="dijkstra"))
        assert r.algorithm == "dijkstra"
    def test_waypoint_count(self, three_wps):
        assert plan_route(PlanRequest(waypoints=three_wps, algorithm="astar")).waypoint_count == 3
    def test_segments_n_minus_1(self, three_wps):
        assert len(plan_route(PlanRequest(waypoints=three_wps, algorithm="astar")).segments) == 2
    def test_duration_positive(self, three_wps):
        assert plan_route(PlanRequest(waypoints=three_wps, algorithm="astar")).estimated_duration_min > 0
    def test_segment_distances_positive(self, three_wps):
        for seg in plan_route(PlanRequest(waypoints=three_wps, algorithm="astar")).segments:
            assert seg.distance_km > 0
    def test_bearings_in_range(self, three_wps):
        for seg in plan_route(PlanRequest(waypoints=three_wps, algorithm="astar")).segments:
            assert 0 <= seg.bearing < 360
    def test_invalid_algo_raises(self, three_wps):
        from fastapi import HTTPException
        with pytest.raises(HTTPException): plan_route(PlanRequest(waypoints=three_wps, algorithm="bfs"))
    def test_one_waypoint_raises(self, boston):
        from fastapi import HTTPException
        with pytest.raises(HTTPException): plan_route(PlanRequest(waypoints=[boston], algorithm="astar"))
    def test_two_waypoints_valid(self, boston, cambridge):
        r = plan_route(PlanRequest(waypoints=[boston,cambridge], algorithm="astar"))
        assert r.waypoint_count == 2