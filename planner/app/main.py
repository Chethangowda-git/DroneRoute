from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict
import heapq, math

app = FastAPI(title="DroneRoute Planner API", version="2.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── Models ─────────────────────────────────────────────────────────────────

class Waypoint(BaseModel):
    lat: float
    lng: float
    altitude: float = 50.0
    label: Optional[str] = None

class ObstacleZone(BaseModel):
    type: str                          # "circle" | "polygon"
    center_lat: Optional[float] = None
    center_lng: Optional[float] = None
    radius_km:  Optional[float] = None
    points: Optional[List[Dict]]  = None   # [{lat, lng}, ...]

class PlanRequest(BaseModel):
    waypoints:  List[Waypoint]
    algorithm:  str = "astar"
    obstacles:  List[ObstacleZone] = []

class PathSegment(BaseModel):
    from_wp:      int
    to_wp:        int
    distance_km:  float
    bearing:      float

class PlanResponse(BaseModel):
    algorithm:             str
    ordered_waypoints:     List[Waypoint]
    path_points:           List[Dict]      # detailed grid path for map polyline
    segments:              List[PathSegment]
    total_distance_km:     float
    estimated_duration_min: float
    waypoint_count:        int
    obstacle_count:        int

# ── Constants ──────────────────────────────────────────────────────────────

DRONE_SPEED_KMH = 60.0
GRID_RESOLUTION = 0.00025   # ~28m per cell
MAX_GRID_SIZE   = 450        # cap grid to 450×450 cells

# ── Math helpers ───────────────────────────────────────────────────────────

def haversine(lat1, lng1, lat2, lng2) -> float:
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a  = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

def bearing(lat1, lng1, lat2, lng2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lng2 - lng1)
    x  = math.sin(dl)*math.cos(p2)
    y  = math.cos(p1)*math.sin(p2) - math.sin(p1)*math.cos(p2)*math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360) % 360

# ── Obstacle geometry ──────────────────────────────────────────────────────

def point_in_circle(lat, lng, clat, clng, radius_km) -> bool:
    return haversine(lat, lng, clat, clng) <= radius_km

def point_in_polygon(lat, lng, points) -> bool:
    """Ray-casting algorithm."""
    n, inside, j = len(points), False, len(points) - 1
    for i in range(n):
        xi, yi = points[i]["lng"], points[i]["lat"]
        xj, yj = points[j]["lng"], points[j]["lat"]
        if ((yi > lat) != (yj > lat)) and (lng < (xj-xi)*(lat-yi)/(yj-yi)+xi):
            inside = not inside
        j = i
    return inside

# ── Grid A* ────────────────────────────────────────────────────────────────

def _to_cell(lat, lng, min_lat, min_lng, res_lat, res_lng):
    return int((lat - min_lat) / res_lat), int((lng - min_lng) / res_lng)

def _to_latlng(r, c, min_lat, min_lng, res_lat, res_lng):
    return min_lat + r * res_lat, min_lng + c * res_lng

def _simplify(path, tol=0.000008):
    """Remove nearly-collinear intermediate points."""
    if len(path) <= 2:
        return path
    result = [path[0]]
    for i in range(1, len(path) - 1):
        p1, p2, p3 = path[i-1], path[i], path[i+1]
        dx1, dy1 = p2[0]-p1[0], p2[1]-p1[1]
        dx2, dy2 = p3[0]-p2[0], p3[1]-p2[1]
        if abs(dx1*dy2 - dy1*dx2) > tol:
            result.append(path[i])
    result.append(path[-1])
    return result

def grid_astar(start: Waypoint, end: Waypoint, obstacles: List[ObstacleZone]) -> List[Dict]:
    pad = 0.008
    min_lat = min(start.lat, end.lat) - pad
    max_lat = max(start.lat, end.lat) + pad
    min_lng = min(start.lng, end.lng) - pad
    max_lng = max(start.lng, end.lng) + pad

    raw_rows = int((max_lat - min_lat) / GRID_RESOLUTION) + 1
    raw_cols = int((max_lng - min_lng) / GRID_RESOLUTION) + 1
    rows = min(raw_rows, MAX_GRID_SIZE)
    cols = min(raw_cols, MAX_GRID_SIZE)
    res_lat = (max_lat - min_lat) / rows
    res_lng = (max_lng - min_lng) / cols

    # ── Build blocked set (only check cells near each obstacle bbox) ──
    blocked = set()
    for obs in obstacles:
        if obs.type == "circle" and obs.center_lat is not None:
            cr, cc = _to_cell(obs.center_lat, obs.center_lng, min_lat, min_lng, res_lat, res_lng)
            rad_cells = int(obs.radius_km / (res_lat * 111)) + 2
            for r in range(max(0, cr-rad_cells), min(rows, cr+rad_cells+1)):
                for c in range(max(0, cc-rad_cells), min(cols, cc+rad_cells+1)):
                    la, ln = _to_latlng(r, c, min_lat, min_lng, res_lat, res_lng)
                    if point_in_circle(la, ln, obs.center_lat, obs.center_lng, obs.radius_km):
                        blocked.add((r, c))

        elif obs.type == "polygon" and obs.points:
            lats = [p["lat"] for p in obs.points]
            lngs = [p["lng"] for p in obs.points]
            r0, c0 = _to_cell(min(lats), min(lngs), min_lat, min_lng, res_lat, res_lng)
            r1, c1 = _to_cell(max(lats), max(lngs), min_lat, min_lng, res_lat, res_lng)
            for r in range(max(0, r0-1), min(rows, r1+2)):
                for c in range(max(0, c0-1), min(cols, c1+2)):
                    la, ln = _to_latlng(r, c, min_lat, min_lng, res_lat, res_lng)
                    if point_in_polygon(la, ln, obs.points):
                        blocked.add((r, c))

    sr, sc = _to_cell(start.lat, start.lng, min_lat, min_lng, res_lat, res_lng)
    er, ec = _to_cell(end.lat,   end.lng,   min_lat, min_lng, res_lat, res_lng)
    s_cell = (max(0, min(rows-1, sr)), max(0, min(cols-1, sc)))
    e_cell = (max(0, min(rows-1, er)), max(0, min(cols-1, ec)))

    def h(r, c):
        la, ln = _to_latlng(r, c, min_lat, min_lng, res_lat, res_lng)
        ela, eln = _to_latlng(e_cell[0], e_cell[1], min_lat, min_lng, res_lat, res_lng)
        return haversine(la, ln, ela, eln)

    g_score = {s_cell: 0.0}
    prev     = {}
    pq       = [(h(*s_cell), 0.0, s_cell)]
    visited  = set()
    DIRS     = [(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(-1,1),(1,-1),(1,1)]

    while pq:
        _, g, cur = heapq.heappop(pq)
        if cur in visited: continue
        visited.add(cur)
        if cur == e_cell: break
        r, c = cur
        for dr, dc in DIRS:
            nr, nc = r+dr, c+dc
            if not (0 <= nr < rows and 0 <= nc < cols): continue
            nxt = (nr, nc)
            if nxt in blocked or nxt in visited: continue
            step = 1.414 if dr and dc else 1.0
            ng   = g + step
            if ng < g_score.get(nxt, float("inf")):
                g_score[nxt] = ng
                prev[nxt]    = cur
                heapq.heappush(pq, (ng + h(nr, nc), ng, nxt))

    # Reconstruct
    raw, cur = [], e_cell
    while cur in prev:
        raw.append(cur); cur = prev[cur]
    raw.append(s_cell)
    raw.reverse()

    simplified = _simplify(raw)
    return [{"lat": round(_to_latlng(r, c, min_lat, min_lng, res_lat, res_lng)[0], 6),
             "lng": round(_to_latlng(r, c, min_lat, min_lng, res_lat, res_lng)[1], 6)}
            for r, c in simplified]

# ── Original waypoint-graph helpers (kept for no-obstacle fallback) ────────

def build_graph(wps):
    n = len(wps)
    g = {i: [] for i in range(n)}
    for i in range(n):
        for j in range(n):
            if i != j:
                d = haversine(wps[i].lat, wps[i].lng, wps[j].lat, wps[j].lng)
                g[i].append((d, j))
    return g

def dijkstra(graph, start, end):
    n = len(graph)
    dist, prev = [float("inf")]*n, [-1]*n
    dist[start] = 0
    pq = [(0.0, start)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist[u]: continue
        for cost, v in graph[u]:
            if dist[u]+cost < dist[v]:
                dist[v] = dist[u]+cost; prev[v] = u
                heapq.heappush(pq, (dist[v], v))
    path, cur = [], end
    while cur != -1: path.append(cur); cur = prev[cur]
    return list(reversed(path))

def astar_wp(graph, wps, start, end):
    n = len(graph)
    g_s = [float("inf")]*n; g_s[start] = 0; prev = [-1]*n
    h   = lambda i: haversine(wps[i].lat, wps[i].lng, wps[end].lat, wps[end].lng)
    pq  = [(h(start), 0.0, start)]
    while pq:
        f, g, u = heapq.heappop(pq)
        if u == end: break
        if g > g_s[u]: continue
        for cost, v in graph[u]:
            ng = g_s[u]+cost
            if ng < g_s[v]:
                g_s[v] = ng; prev[v] = u
                heapq.heappush(pq, (ng+h(v), ng, v))
    path, cur = [], end
    while cur != -1: path.append(cur); cur = prev[cur]
    return list(reversed(path))

def nearest_neighbor_tsp(wps):
    n = len(wps)
    if n <= 2: return list(range(n))
    visited, order = [False]*n, [0]; visited[0] = True
    for _ in range(n-1):
        last = order[-1]; best, nearest = float("inf"), -1
        for j in range(n):
            if not visited[j]:
                d = haversine(wps[last].lat, wps[last].lng, wps[j].lat, wps[j].lng)
                if d < best: best, nearest = d, j
        order.append(nearest); visited[nearest] = True
    return order

# ── Endpoints ──────────────────────────────────────────────────────────────

@app.get("/health")
def health(): return {"status": "ok", "service": "planner", "version": "2.0.0"}

@app.get("/algorithms")
def list_algorithms():
    return {"algorithms": [
        {"id": "astar",    "name": "A* Grid",  "description": "Obstacle-aware heuristic grid search", "complexity": "O(E log V)"},
        {"id": "dijkstra", "name": "Dijkstra", "description": "Exhaustive shortest path on waypoints", "complexity": "O((V+E) log V)"},
    ]}

@app.post("/plan", response_model=PlanResponse)
def plan_route(req: PlanRequest):
    wps = req.waypoints
    if len(wps) < 2:   raise HTTPException(400, "At least 2 waypoints required.")
    if len(wps) > 50:  raise HTTPException(400, "Maximum 50 waypoints per mission.")
    if req.algorithm not in ("astar", "dijkstra"):
        raise HTTPException(400, "Algorithm must be 'astar' or 'dijkstra'.")

    ordered_wps = [wps[i] for i in nearest_neighbor_tsp(wps)] if len(wps) > 2 else list(wps)

    segments: List[PathSegment] = []
    all_path_points: List[Dict] = []
    total_dist = 0.0

    for i in range(len(ordered_wps) - 1):
        w0, w1 = ordered_wps[i], ordered_wps[i+1]
        dist = haversine(w0.lat, w0.lng, w1.lat, w1.lng)
        b    = bearing(w0.lat, w0.lng, w1.lat, w1.lng)

        # Choose path strategy
        if req.obstacles:
            seg_points = grid_astar(w0, w1, req.obstacles)
        else:
            seg_points = [{"lat": w0.lat, "lng": w0.lng},
                          {"lat": w1.lat, "lng": w1.lng}]

        # Append (avoid duplicate junction points)
        if i == 0:
            all_path_points.extend(seg_points)
        else:
            all_path_points.extend(seg_points[1:])

        segments.append(PathSegment(from_wp=i, to_wp=i+1,
                                    distance_km=round(dist, 4),
                                    bearing=round(b, 2)))
        total_dist += dist

    return PlanResponse(
        algorithm=req.algorithm,
        ordered_waypoints=ordered_wps,
        path_points=all_path_points,
        segments=segments,
        total_distance_km=round(total_dist, 4),
        estimated_duration_min=round((total_dist / DRONE_SPEED_KMH) * 60, 2),
        waypoint_count=len(ordered_wps),
        obstacle_count=len(req.obstacles),
    )