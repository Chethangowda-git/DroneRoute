import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  MapContainer, TileLayer, Marker, Polyline,
  Popup, useMapEvents, Circle, Polygon
} from "react-leaflet";
import L from "leaflet";
import axios from "axios";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  AreaChart, Area, ResponsiveContainer, ReferenceLine,
} from "recharts";

const API = process.env.REACT_APP_BACKEND_URL || "http://localhost:3001";

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});
const homeIcon = new L.Icon({
  iconUrl:   "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-green.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41], iconAnchor: [12, 41],
});
const waypointIcon = new L.Icon({
  iconUrl:   "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41], iconAnchor: [12, 41],
});
const droneIcon = new L.DivIcon({
  html: `<div style="font-size:22px;line-height:1;filter:drop-shadow(0 0 6px #38bdf8);transform:translateX(-2px) translateY(-2px);">🚁</div>`,
  className: "", iconSize: [24, 24], iconAnchor: [12, 12],
});

// ── Haversine ────────────────────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180)
    * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Build altitude/depth profile ─────────────────────────────────────────────
// Interpolates waypoint altitudes across path_points to produce a cross-section.
// For AUV context: altitude = height above sea floor; depth = -altitude.
function buildDepthProfile(pathPoints, waypoints) {
  if (!pathPoints.length || !waypoints.length) return { samples: [], anchors: [] };

  // Cumulative distance along path
  const cumDist = [0];
  for (let i = 1; i < pathPoints.length; i++) {
    cumDist.push(
      cumDist[i - 1] + haversineKm(
        pathPoints[i - 1].lat, pathPoints[i - 1].lng,
        pathPoints[i].lat,     pathPoints[i].lng
      )
    );
  }

  // Snap each waypoint to nearest path_point
  const anchors = waypoints.map(wp => {
    let best = { dist: Infinity, idx: 0 };
    pathPoints.forEach((pp, i) => {
      const d = haversineKm(parseFloat(wp.lat), parseFloat(wp.lng), pp.lat, pp.lng);
      if (d < best.dist) best = { dist: d, idx: i };
    });
    return {
      cumD:  cumDist[best.idx],
      alt:   parseFloat(wp.altitude) || 60,
      label: wp.label || "WP",
    };
  }).sort((a, b) => a.cumD - b.cumD);

  // Sample up to 100 points
  const step = Math.max(1, Math.floor(pathPoints.length / 100));
  const samples = [];
  for (let i = 0; i < pathPoints.length; i += step) {
    const d      = cumDist[i];
    const before = [...anchors].reverse().find(a => a.cumD <= d) || anchors[0];
    const after  = anchors.find(a => a.cumD > d)                 || anchors[anchors.length - 1];
    let alt;
    if (!before || !after || before === after || after.cumD === before.cumD) {
      alt = (before || after)?.alt || 60;
    } else {
      const t = (d - before.cumD) / (after.cumD - before.cumD);
      alt = before.alt + t * (after.alt - before.alt);
    }
    samples.push({
      dist:  parseFloat(d.toFixed(3)),
      alt:   parseFloat(alt.toFixed(1)),
    });
  }
  return { samples, anchors };
}

// ── OSM Fetcher ──────────────────────────────────────────────────────────────
async function fetchOSMObstacles(waypoints) {
  if (!waypoints.length) return [];
  const lats = waypoints.map(w => parseFloat(w.lat));
  const lngs = waypoints.map(w => parseFloat(w.lng));
  const pad  = 0.012;
  const bbox = `${Math.min(...lats)-pad},${Math.min(...lngs)-pad},${Math.max(...lats)+pad},${Math.max(...lngs)+pad}`;
  const query = `[out:json][timeout:20];
(
  way["building"](${bbox});
  way["leisure"="park"](${bbox});
  way["landuse"="forest"](${bbox});
  way["natural"="wood"](${bbox});
  way["landuse"="grass"](${bbox});
);
out geom;`;
  try {
    const res = await axios.post(
      "https://overpass-api.de/api/interpreter",
      query,
      { headers: { "Content-Type": "text/plain" }, timeout: 20000 }
    );
    return (res.data.elements || [])
      .filter(el => el.geometry && el.geometry.length >= 3)
      .map(el => ({
        type:   "polygon",
        points: el.geometry.map(p => ({ lat: p.lat, lng: p.lon })),
        kind:   el.tags?.building ? "building" : "greenspace",
      }));
  } catch (err) {
    console.warn("OSM fetch failed:", err.message);
    return [];
  }
}

// ── Map click handler ────────────────────────────────────────────────────────
function MapClickHandler({ mode, onWaypoint, onZone }) {
  useMapEvents({
    click: (e) => {
      if (mode === "add")  onWaypoint(e.latlng);
      if (mode === "zone") onZone(e.latlng);
    }
  });
  return null;
}

// ── Algorithm Comparison Chart (Recharts) ─────────────────────────────────
function AlgorithmCompareChart({ astarRoute, dijkstraRoute }) {
  const data = [
    {
      metric:   "Distance (km)",
      "A* Grid":  parseFloat(astarRoute.total_distance_km)    || 0,
      Dijkstra:   parseFloat(dijkstraRoute.total_distance_km) || 0,
    },
    {
      metric:   "Duration (min)",
      "A* Grid":  parseFloat((astarRoute.estimated_duration_min    || 0).toFixed(1)),
      Dijkstra:   parseFloat((dijkstraRoute.estimated_duration_min || 0).toFixed(1)),
    },
    {
      metric:   "Path Points",
      "A* Grid":  astarRoute.path_points?.length    || 0,
      Dijkstra:   dijkstraRoute.path_points?.length || 0,
    },
  ];
  return (
    <ResponsiveContainer width="100%" height={185}>
      <BarChart data={data} margin={{ top: 10, right: 24, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e2d4a" />
        <XAxis dataKey="metric" tick={{ fill: "#94a3b8", fontSize: 11 }} />
        <YAxis tick={{ fill: "#94a3b8", fontSize: 10 }} />
        <Tooltip
          contentStyle={{ background: "#0f1629", border: "1px solid #2d4168", fontSize: 11, borderRadius: 6 }}
          labelStyle={{ color: "#e2e8f0" }}
          cursor={{ fill: "rgba(255,255,255,0.04)" }}
        />
        <Legend wrapperStyle={{ fontSize: 11, color: "#94a3b8", paddingTop: 4 }} />
        <Bar dataKey="A* Grid"  fill="#60a5fa" radius={[4, 4, 0, 0]} />
        <Bar dataKey="Dijkstra" fill="#fb923c" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Depth / Altitude Profile Chart (Recharts AreaChart) ──────────────────────
function DepthProfileChart({ profileData }) {
  const { samples, anchors } = profileData;
  if (!samples?.length) {
    return (
      <div style={{ color: "#475569", textAlign: "center", paddingTop: 60, fontSize: 12 }}>
        Plan a route to see the altitude / depth profile
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={185}>
      <AreaChart data={samples} margin={{ top: 10, right: 24, left: 40, bottom: 20 }}>
        <defs>
          <linearGradient id="altGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor="#38bdf8" stopOpacity={0.35} />
            <stop offset="95%" stopColor="#38bdf8" stopOpacity={0.03} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e2d4a" />
        <XAxis
          dataKey="dist"
          tick={{ fill: "#94a3b8", fontSize: 10 }}
          label={{ value: "Distance (km)", position: "insideBottom", offset: -12, fill: "#64748b", fontSize: 10 }}
        />
        <YAxis
          tick={{ fill: "#94a3b8", fontSize: 10 }}
          label={{ value: "Altitude (m)", angle: -90, position: "insideLeft", offset: -28, fill: "#64748b", fontSize: 10 }}
        />
        <Tooltip
          contentStyle={{ background: "#0f1629", border: "1px solid #2d4168", fontSize: 11, borderRadius: 6 }}
          formatter={(v) => [`${v}m`, "Altitude"]}
          labelFormatter={(l) => `${l} km`}
        />
        {/* Waypoint reference lines */}
        {anchors?.map((a, i) => (
          <ReferenceLine
            key={i}
            x={parseFloat(a.cumD.toFixed(3))}
            stroke="#4ade80"
            strokeDasharray="4 3"
            strokeWidth={1}
            label={{ value: a.label, fill: "#4ade80", fontSize: 9, position: "top" }}
          />
        ))}
        <Area
          type="monotone"
          dataKey="alt"
          stroke="#38bdf8"
          fill="url(#altGrad)"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, fill: "#38bdf8" }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── Constants ────────────────────────────────────────────────────────────────
const STATUS_COLORS  = { draft: "#f59e0b", active: "#22c55e", completed: "#60a5fa" };
const WP_COLORS      = ["#22c55e", "#ef4444", "#f59e0b", "#a78bfa", "#06b6d4", "#fb7185"];
const ZONE_RADIUS_KM = 0.12;

// ── App ──────────────────────────────────────────────────────────────────────
export default function App() {

  // Existing state
  const [missions,      setMissions]      = useState([]);
  const [activeMission, setActiveMission] = useState(null);
  const [waypoints,     setWaypoints]     = useState([]);
  const [route,         setRoute]         = useState(null);
  const [algorithm,     setAlgorithm]     = useState("astar");
  const [missionName,   setMissionName]   = useState("");
  const [loading,       setLoading]       = useState(false);
  const [toast,         setToast]         = useState(null);
  const [mode,          setMode]          = useState("view");
  const [noFlyZones,    setNoFlyZones]    = useState([]);
  const [osmData,       setOsmData]       = useState([]);
  const [osmLoading,    setOsmLoading]    = useState(false);
  const zoneId = useRef(0);

  // Replay state
  const [isReplaying,     setIsReplaying]     = useState(false);
  const [replayIndex,     setReplayIndex]     = useState(0);
  const [replaySpeed,     setReplaySpeed]     = useState(1);
  const [distanceCovered, setDistanceCovered] = useState(0);
  const [currentWaypoint, setCurrentWaypoint] = useState(null);
  const replayTimerRef = useRef(null);

  // New: comparison + analytics state
  const [astarRoute,     setAstarRoute]     = useState(null);
  const [dijkstraRoute,  setDijkstraRoute]  = useState(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [showAnalytics,  setShowAnalytics]  = useState(false);
  const [analyticsTab,   setAnalyticsTab]   = useState("depth");

  // Derived
  const pathPoints    = route?.path_points || [];
  const hasComparison = !!(astarRoute && dijkstraRoute);

  // Depth profile — recomputes only when route or waypoints change
  const depthProfileData = useMemo(
    () => buildDepthProfile(route?.path_points || [], waypoints),
    [route, waypoints]
  );

  // ── Replay engine ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (isReplaying && pathPoints.length > 0) {
      const intervalMs = Math.round(80 / replaySpeed);
      replayTimerRef.current = setInterval(() => {
        setReplayIndex(prev => {
          if (prev >= pathPoints.length - 1) { setIsReplaying(false); return prev; }
          return prev + 1;
        });
      }, intervalMs);
    } else {
      clearInterval(replayTimerRef.current);
    }
    return () => clearInterval(replayTimerRef.current);
  }, [isReplaying, replaySpeed, pathPoints.length]);

  useEffect(() => {
    if (!pathPoints.length || replayIndex === 0) {
      setDistanceCovered(0); setCurrentWaypoint(null); return;
    }
    let d = 0;
    for (let i = 1; i <= replayIndex && i < pathPoints.length; i++) {
      d += haversineKm(pathPoints[i-1].lat, pathPoints[i-1].lng, pathPoints[i].lat, pathPoints[i].lng);
    }
    setDistanceCovered(d);
    if (waypoints.length > 0) {
      const cur     = pathPoints[replayIndex];
      const nearest = waypoints.reduce((best, wp, idx) => {
        const dist = haversineKm(cur.lat, cur.lng, parseFloat(wp.lat), parseFloat(wp.lng));
        return dist < best.dist ? { dist, idx } : best;
      }, { dist: Infinity, idx: 0 });
      if (nearest.dist < 0.04) setCurrentWaypoint(waypoints[nearest.idx]?.label || `WP ${nearest.idx + 1}`);
    }
  }, [replayIndex, pathPoints, waypoints]);

  useEffect(() => {
    setIsReplaying(false); setReplayIndex(0);
    setDistanceCovered(0); setCurrentWaypoint(null);
  }, [route]);

  const startReplay = () => {
    if (!pathPoints.length) return showToast("Plan a route first");
    if (replayIndex >= pathPoints.length - 1) setReplayIndex(0);
    setIsReplaying(true);
  };
  const pauseReplay = () => setIsReplaying(false);
  const resetReplay = () => {
    setIsReplaying(false); setReplayIndex(0);
    setDistanceCovered(0); setCurrentWaypoint(null);
  };

  // ── Handlers ──────────────────────────────────────────────────────────────
  const showToast = (msg, dur = 3000) => { setToast(msg); setTimeout(() => setToast(null), dur); };

  const fetchMissions = useCallback(async () => {
    try { const r = await axios.get(`${API}/api/missions`); setMissions(r.data); } catch {}
  }, []);
  useEffect(() => { fetchMissions(); }, [fetchMissions]);

  const loadMission = async (m) => {
    try {
      const r = await axios.get(`${API}/api/missions/${m.id}`);
      setActiveMission(r.data);
      setWaypoints(r.data.waypoints || []);
      setRoute(r.data.latest_route?.path_json || null);
      setNoFlyZones([]); setOsmData([]);
      setAstarRoute(null); setDijkstraRoute(null); setShowAnalytics(false);
    } catch { showToast("Failed to load mission"); }
  };

  const createMission = async () => {
    if (!missionName.trim()) return showToast("Enter a mission name");
    try {
      const r = await axios.post(`${API}/api/missions`, { name: missionName.trim() });
      setMissionName("");
      await fetchMissions();
      await loadMission(r.data);
      setMode("add");
      showToast(`"${r.data.name}" created — click map to add waypoints`);
    } catch { showToast("Failed to create mission"); }
  };

  const handleWaypointClick = async ({ lat, lng }) => {
    if (!activeMission) return;
    try {
      const r = await axios.post(`${API}/api/missions/${activeMission.id}/waypoints`, {
        lat, lng, altitude: 60,
        label: waypoints.length === 0 ? "Home" : `WP${waypoints.length + 1}`,
      });
      setWaypoints(prev => [...prev, r.data]);
    } catch { showToast("Failed to add waypoint"); }
  };

  const handleZoneClick = ({ lat, lng }) => {
    const id = zoneId.current++;
    setNoFlyZones(prev => [...prev, { id, lat, lng, radius_km: ZONE_RADIUS_KM }]);
    showToast(`No-fly zone placed (r=${ZONE_RADIUS_KM * 1000}m)`);
  };

  const removeZone = (id) => setNoFlyZones(prev => prev.filter(z => z.id !== id));

  const clearWaypoints = async () => {
    if (!activeMission) return;
    await axios.delete(`${API}/api/missions/${activeMission.id}/waypoints`);
    setWaypoints([]); setRoute(null); setOsmData([]);
    setAstarRoute(null); setDijkstraRoute(null); setShowAnalytics(false);
  };

  const handleFetchOSM = async () => {
    if (!waypoints.length) return;
    setOsmLoading(true);
    showToast("Fetching buildings & parks from OpenStreetMap...", 5000);
    const data = await fetchOSMObstacles(waypoints);
    setOsmData(data);
    showToast(`Loaded ${data.length} obstacles from OSM`);
    setOsmLoading(false);
  };

  const buildObstacles = () => [
    ...noFlyZones.map(z => ({ type: "circle", center_lat: z.lat, center_lng: z.lng, radius_km: z.radius_km })),
    ...osmData.map(o => ({ type: "polygon", points: o.points })),
  ];

  const planRoute = async () => {
    if (!activeMission || waypoints.length < 2) return;
    setLoading(true);
    try {
      const r = await axios.post(`${API}/api/missions/${activeMission.id}/plan`, {
        algorithm, obstacles: buildObstacles(),
      });
      setRoute(r.data);
      setAstarRoute(null); setDijkstraRoute(null);
      setMode("view");
      showToast(`Route computed (${algorithm.toUpperCase()}) · ${r.data.total_distance_km}km · ${r.data.obstacle_count} obstacles avoided`);
    } catch (err) {
      showToast(err.response?.data?.error || "Planning failed");
    } finally { setLoading(false); }
  };

  // Run both algorithms in parallel and store results separately
  const compareRoutes = async () => {
    if (!activeMission || waypoints.length < 2) return;
    setCompareLoading(true);
    try {
      const obstacles = buildObstacles();
      const [rA, rD] = await Promise.all([
        axios.post(`${API}/api/missions/${activeMission.id}/plan`, { algorithm: "astar",    obstacles }),
        axios.post(`${API}/api/missions/${activeMission.id}/plan`, { algorithm: "dijkstra", obstacles }),
      ]);
      setAstarRoute(rA.data);
      setDijkstraRoute(rD.data);
      setRoute(rA.data); // A* as primary for replay + depth profile
      setMode("view");
      setShowAnalytics(true);
      setAnalyticsTab("compare");
      showToast("A* vs Dijkstra — comparison ready");
    } catch (err) {
      showToast(err.response?.data?.error || "Comparison failed");
    } finally { setCompareLoading(false); }
  };

  // Derived map values
  const singlePolylinePoints = route?.path_points
    ? route.path_points.map(p => [p.lat, p.lng])
    : waypoints.map(wp => [parseFloat(wp.lat), parseFloat(wp.lng)]);

  const mapCenter = waypoints.length
    ? [parseFloat(waypoints[0].lat), parseFloat(waypoints[0].lng)]
    : [42.3601, -71.0589];

  const replayProgress = pathPoints.length > 1
    ? Math.round((replayIndex / (pathPoints.length - 1)) * 100)
    : 0;

  const isAnyLoading = loading || compareLoading;
  const canPlan      = !!(activeMission && waypoints.length >= 2 && !isAnyLoading);

  // ── Styles ────────────────────────────────────────────────────────────────
  const s = {
    app:      { display: "flex", height: "100vh", overflow: "hidden" },
    sidebar:  { width: "340px", background: "#0f1629", borderRight: "1px solid #1e2d4a", display: "flex", flexDirection: "column", overflowY: "auto" },
    mapArea:  { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" },
    header:   { padding: "16px 18px", background: "linear-gradient(135deg,#1a2744,#0d1b35)", borderBottom: "1px solid #1e2d4a" },
    title:    { fontSize: "17px", fontWeight: 700, color: "#60a5fa", letterSpacing: "2px" },
    subtitle: { fontSize: "10px", color: "#475569", marginTop: "3px" },
    section:  { padding: "12px 14px", borderBottom: "1px solid #1e2d4a" },
    label:    { fontSize: "10px", color: "#64748b", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "7px" },
    input:    { width: "100%", background: "#1e2d4a", border: "1px solid #2d4168", borderRadius: "6px", padding: "7px 10px", color: "#e2e8f0", fontSize: "13px", marginBottom: "7px", outline: "none" },
    btn:      (bg, full) => ({ width: full ? "100%" : "auto", padding: full ? "9px" : "7px 12px", background: bg, border: "none", borderRadius: "6px", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: "pointer" }),
    btnGhost: (active) => ({ padding: "7px 0", background: active ? "#1e3a5f" : "transparent", border: "1px solid #2d4168", borderRadius: "5px", color: active ? "#93c5fd" : "#94a3b8", fontSize: "12px", cursor: "pointer", flex: 1 }),
    select:   { background: "#1e2d4a", border: "1px solid #2d4168", borderRadius: "6px", padding: "7px 10px", color: "#e2e8f0", fontSize: "12px", width: "100%", marginBottom: "7px" },
    wpList:   { overflowY: "visible", padding: "6px 12px" },
    wpItem:   { display: "flex", alignItems: "center", gap: "8px", padding: "7px", background: "#1a2744", borderRadius: "6px", marginBottom: "4px", fontSize: "12px" },
    badge:    (color) => ({ width: "20px", height: "20px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "10px", fontWeight: 700, flexShrink: 0, background: color, color: "#000" }),
    stats:    { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px", padding: "12px" },
    statBox:  { background: "#1a2744", borderRadius: "7px", padding: "9px", textAlign: "center" },
    statVal:  { fontSize: "17px", fontWeight: 700, color: "#60a5fa" },
    statKey:  { fontSize: "10px", color: "#64748b", marginTop: "2px" },
    mItem:    (active) => ({ padding: "7px 10px", cursor: "pointer", borderRadius: "6px", marginBottom: "3px", fontSize: "13px", display: "flex", alignItems: "center", gap: "8px", background: active ? "#1e3a5f" : "#1a2744", border: active ? "1px solid #2563eb" : "1px solid transparent" }),
    dot:      (st) => ({ width: "7px", height: "7px", borderRadius: "50%", background: STATUS_COLORS[st] || "#94a3b8", flexShrink: 0 }),
    zoneItem: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 8px", background: "#2d1515", borderRadius: "5px", marginBottom: "3px", fontSize: "11px" },
    replayPanel:    { padding: "12px 14px", borderBottom: "1px solid #1e2d4a", background: "#0a1020" },
    replayLabel:    { fontSize: "10px", color: "#38bdf8", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px" },
    replayControls: { display: "flex", gap: "5px", marginBottom: "10px" },
    replayBtn:  (bg, disabled) => ({ flex: 1, padding: "8px 0", background: disabled ? "#1e2d4a" : bg, border: "none", borderRadius: "6px", color: disabled ? "#475569" : "#fff", fontSize: "13px", fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }),
    speedBtn:   (active) => ({ padding: "5px 10px", background: active ? "#0e4f7a" : "#1e2d4a", border: active ? "1px solid #38bdf8" : "1px solid #2d4168", borderRadius: "5px", color: active ? "#38bdf8" : "#64748b", fontSize: "11px", fontWeight: 600, cursor: "pointer" }),
    progressBar:   { width: "100%", height: "5px", background: "#1e2d4a", borderRadius: "3px", overflow: "hidden", marginBottom: "8px" },
    progressFill:  (pct) => ({ width: `${pct}%`, height: "100%", background: "linear-gradient(90deg,#2563eb,#38bdf8)", transition: "width 0.1s linear", borderRadius: "3px" }),
    replayStat:    { display: "flex", justifyContent: "space-between", fontSize: "11px", color: "#94a3b8", marginTop: "4px" },
    replayStatVal: { color: "#38bdf8", fontWeight: 600 },
    wpBadge:       { display: "inline-block", padding: "2px 8px", background: "#0e4f7a", borderRadius: "10px", color: "#38bdf8", fontSize: "10px", fontWeight: 600 },
    analyticsPanel:  { height: "240px", background: "#0a1020", borderTop: "2px solid #1e2d4a", display: "flex", flexDirection: "column", flexShrink: 0 },
    analyticsHeader: { display: "flex", alignItems: "center", padding: "0 14px", borderBottom: "1px solid #1e2d4a", height: "36px", gap: "4px" },
    analyticsTab:    (active) => ({ padding: "6px 14px", background: active ? "#1e3a5f" : "transparent", border: "none", borderRadius: "5px 5px 0 0", color: active ? "#e2e8f0" : "#64748b", fontSize: "11px", fontWeight: 600, cursor: "pointer" }),
    analyticsBody:   { flex: 1, padding: "8px 12px", overflow: "hidden" },
  };

  const modeHints = {
    add:  { color: "#4ade80", border: "#22c55e", text: "✦ Click map to place a waypoint" },
    zone: { color: "#fb923c", border: "#f97316", text: "⊘ Click map to place a no-fly zone" },
  };

  return (
    <div style={s.app}>

      {/* ── Sidebar ── */}
      <div style={s.sidebar}>
        <div style={s.header}>
          <div style={s.title}>⬡ DRONEROUTE</div>
          <div style={s.subtitle}>Obstacle-Aware Mission Planner</div>
        </div>

        {/* Missions */}
        <div style={s.section}>
          <div style={s.label}>Missions</div>
          <div style={{ overflowY: "auto", maxHeight: "130px", marginBottom: "8px" }}>
            {missions.map(m => (
              <div key={m.id} style={s.mItem(activeMission?.id === m.id)} onClick={() => loadMission(m)}>
                <div style={s.dot(m.status)} />
                <span style={{ flex: 1 }}>{m.name}</span>
                <span style={{ fontSize: "10px", color: "#475569", textTransform: "uppercase" }}>{m.status}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: "5px" }}>
            <input
              style={{ ...s.input, marginBottom: 0, flex: 1 }}
              placeholder="New mission name..."
              value={missionName}
              onChange={e => setMissionName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && createMission()}
            />
            <button style={s.btn("#2563eb")} onClick={createMission}>+</button>
          </div>
        </div>

        {activeMission && (<>

          {/* Mode */}
          <div style={s.section}>
            <div style={s.label}>Mode</div>
            <div style={{ display: "flex", gap: "5px" }}>
              <button style={s.btnGhost(mode === "view")} onClick={() => setMode("view")}>View</button>
              <button style={s.btnGhost(mode === "add")}  onClick={() => setMode("add")}>+ Waypoint</button>
              <button
                style={{ ...s.btnGhost(mode === "zone"), color: mode === "zone" ? "#fb923c" : "#94a3b8", background: mode === "zone" ? "#2d1515" : "transparent" }}
                onClick={() => setMode("zone")}
              >⊘ Zone</button>
            </div>
            {noFlyZones.length > 0 && (
              <div style={{ marginTop: "8px", maxHeight: "90px", overflowY: "auto" }}>
                <div style={{ fontSize: "10px", color: "#fb923c", marginBottom: "4px", textTransform: "uppercase", letterSpacing: "1px" }}>
                  No-Fly Zones ({noFlyZones.length})
                </div>
                {noFlyZones.map(z => (
                  <div key={z.id} style={s.zoneItem}>
                    <span style={{ color: "#fb923c" }}>⊘ Zone {z.id + 1}</span>
                    <span style={{ color: "#64748b" }}>{z.lat.toFixed(4)}, {z.lng.toFixed(4)}</span>
                    <button style={s.btn("#7f1d1d")} onClick={() => removeZone(z.id)}>×</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Obstacles + Plan */}
          <div style={s.section}>
            <div style={s.label}>Obstacles</div>
            <button
              style={{ ...s.btn("#065f46"), width: "100%", marginBottom: "8px", opacity: (osmLoading || !waypoints.length) ? 0.5 : 1 }}
              onClick={handleFetchOSM}
              disabled={osmLoading || !waypoints.length}
            >
              {osmLoading ? "Fetching..." : !waypoints.length ? "🗺 Add waypoints first" : "🗺 Fetch OSM Buildings & Parks"}
            </button>
            {(osmData.length > 0 || noFlyZones.length > 0) && (
              <div style={{ fontSize: "11px", color: "#94a3b8", marginBottom: "8px" }}>
                {osmData.length} OSM polygons · {noFlyZones.length} no-fly zones
              </div>
            )}
            <div style={{ ...s.label, marginBottom: "6px" }}>Algorithm</div>
            <select style={s.select} value={algorithm} onChange={e => setAlgorithm(e.target.value)}>
              <option value="astar">A* Grid — Obstacle-aware (recommended)</option>
              <option value="dijkstra">Dijkstra — Waypoint shortest path</option>
            </select>

            {/* Single plan */}
            <button
              style={{ ...s.btn("#2563eb"), width: "100%", marginBottom: "6px", opacity: canPlan ? 1 : 0.5 }}
              onClick={planRoute}
              disabled={!canPlan}
            >
              {loading ? "Computing..." : waypoints.length < 2 ? "Add 2+ waypoints" : "⚡ Plan Route"}
            </button>

            {/* Compare both */}
            <button
              style={{ ...s.btn("#7c3aed"), width: "100%", opacity: canPlan ? 1 : 0.5 }}
              onClick={compareRoutes}
              disabled={!canPlan}
            >
              {compareLoading ? "Comparing..." : "⚖ Compare A* vs Dijkstra"}
            </button>
          </div>

          {/* Waypoints list */}
          <div style={{ padding: "6px 14px 3px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "10px", color: "#64748b", textTransform: "uppercase", letterSpacing: "1px" }}>Waypoints ({waypoints.length})</span>
            {waypoints.length > 0 && <button style={s.btn("#7f1d1d")} onClick={clearWaypoints}>Clear All</button>}
          </div>
          <div style={s.wpList}>
            {waypoints.map((wp, i) => (
              <div key={wp.id || i} style={s.wpItem}>
                <div style={s.badge(WP_COLORS[i % WP_COLORS.length])}>{i + 1}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, color: "#e2e8f0" }}>{wp.label || `WP ${i + 1}`}</div>
                  <div style={{ color: "#475569", fontSize: "11px" }}>
                    {parseFloat(wp.lat).toFixed(4)}, {parseFloat(wp.lng).toFixed(4)} · {wp.altitude}m
                  </div>
                </div>
              </div>
            ))}
            {!waypoints.length && (
              <div style={{ color: "#475569", textAlign: "center", padding: "16px 0", fontSize: "12px" }}>
                Switch to "+ Waypoint" mode and click the map
              </div>
            )}
          </div>

          {/* Route stats */}
          {route && (
            <div style={s.stats}>
              <div style={s.statBox}><div style={s.statVal}>{route.total_distance_km}</div><div style={s.statKey}>km total</div></div>
              <div style={s.statBox}><div style={s.statVal}>{Math.round(route.estimated_duration_min)}</div><div style={s.statKey}>min est.</div></div>
              <div style={s.statBox}><div style={s.statVal}>{route.waypoint_count}</div><div style={s.statKey}>waypoints</div></div>
              <div style={s.statBox}>
                <div style={{ ...s.statVal, fontSize: "13px", color: route.obstacle_count > 0 ? "#fb923c" : "#a78bfa" }}>
                  {route.obstacle_count > 0 ? `${route.obstacle_count} avoided` : route.algorithm?.toUpperCase()}
                </div>
                <div style={s.statKey}>{route.obstacle_count > 0 ? "obstacles" : "algorithm"}</div>
              </div>
            </div>
          )}

          {/* Analytics toggle buttons */}
          {route && (
            <div style={{ padding: "8px 12px", borderBottom: "1px solid #1e2d4a", display: "flex", gap: "5px" }}>
              <button
                style={{ ...s.btnGhost(showAnalytics && analyticsTab === "depth"), flex: 1, fontSize: "11px", padding: "6px 0" }}
                onClick={() => { setShowAnalytics(true); setAnalyticsTab("depth"); }}
              >
                📈 Depth Profile
              </button>
              <button
                style={{ ...s.btnGhost(showAnalytics && analyticsTab === "compare"), flex: 1, fontSize: "11px", padding: "6px 0", opacity: hasComparison ? 1 : 0.4 }}
                onClick={() => {
                  if (hasComparison) { setShowAnalytics(true); setAnalyticsTab("compare"); }
                  else showToast("Run ⚖ Compare A* vs Dijkstra first");
                }}
              >
                ⚖ Algo Compare
              </button>
              {showAnalytics && (
                <button style={{ ...s.btn("#374151"), padding: "6px 10px" }} onClick={() => setShowAnalytics(false)}>✕</button>
              )}
            </div>
          )}

          {/* Replay panel */}
          {route && (
            <div style={s.replayPanel}>
              <div style={s.replayLabel}>
                🚁 Pre-Mission Simulation
                {isReplaying && <span style={{ marginLeft: "auto", color: "#4ade80", fontSize: "10px" }}>● LIVE</span>}
              </div>
              <div style={s.progressBar}><div style={s.progressFill(replayProgress)} /></div>
              <div style={s.replayControls}>
                {!isReplaying
                  ? <button style={s.replayBtn("#2563eb", false)} onClick={startReplay}>
                      ▶ {replayIndex > 0 && replayIndex < pathPoints.length - 1 ? "Resume" : "Play"}
                    </button>
                  : <button style={s.replayBtn("#0369a1", false)} onClick={pauseReplay}>⏸ Pause</button>
                }
                <button style={s.replayBtn("#374151", false)} onClick={resetReplay}>↺</button>
              </div>
              <div style={{ display: "flex", gap: "4px", marginBottom: "10px", alignItems: "center" }}>
                <span style={{ fontSize: "10px", color: "#64748b", marginRight: "4px" }}>Speed:</span>
                {[0.5, 1, 2, 4].map(spd => (
                  <button key={spd} style={s.speedBtn(replaySpeed === spd)} onClick={() => setReplaySpeed(spd)}>{spd}x</button>
                ))}
              </div>
              <div style={s.replayStat}><span>Distance covered</span><span style={s.replayStatVal}>{distanceCovered.toFixed(3)} km</span></div>
              <div style={s.replayStat}><span>Progress</span><span style={s.replayStatVal}>{replayProgress}%</span></div>
              <div style={s.replayStat}><span>Path points</span><span style={s.replayStatVal}>{replayIndex} / {pathPoints.length}</span></div>
              {currentWaypoint && <div style={{ marginTop: "8px" }}><span style={s.wpBadge}>📍 {currentWaypoint}</span></div>}
            </div>
          )}

        </>)}

        {!activeMission && (
          <div style={{ padding: "24px", color: "#475569", fontSize: "13px", textAlign: "center" }}>
            Select or create a mission to begin
          </div>
        )}
      </div>

      {/* ── Map area (map + analytics panel) ── */}
      <div style={s.mapArea}>

        <MapContainer center={mapCenter} zoom={14} style={{ flex: 1, minHeight: 0 }}>
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='© <a href="https://www.openstreetmap.org">OpenStreetMap</a>'
          />
          <MapClickHandler mode={mode} onWaypoint={handleWaypointClick} onZone={handleZoneClick} />

          {/* OSM polygons */}
          {osmData.map((obs, i) => (
            <Polygon key={`osm-${i}`}
              positions={obs.points.map(p => [p.lat, p.lng])}
              pathOptions={{ color: obs.kind === "building" ? "#94a3b8" : "#4ade80", fillColor: obs.kind === "building" ? "#1e293b" : "#14532d", fillOpacity: 0.55, weight: 1 }}
            />
          ))}

          {/* No-fly zones */}
          {noFlyZones.map(z => (
            <Circle key={z.id} center={[z.lat, z.lng]} radius={z.radius_km * 1000}
              pathOptions={{ color: "#f97316", fillColor: "#7c2d12", fillOpacity: 0.4, weight: 2 }}>
              <Popup>
                <strong style={{ color: "#f97316" }}>⊘ No-Fly Zone</strong><br />
                {z.lat.toFixed(5)}, {z.lng.toFixed(5)} · r={z.radius_km * 1000}m<br />
                <button onClick={() => removeZone(z.id)} style={{ marginTop: "4px", padding: "2px 8px", background: "#dc2626", border: "none", borderRadius: "4px", color: "#fff", cursor: "pointer" }}>Remove</button>
              </Popup>
            </Circle>
          ))}

          {/* Waypoint markers */}
          {waypoints.map((wp, i) => (
            <Marker key={wp.id || i} position={[parseFloat(wp.lat), parseFloat(wp.lng)]} icon={i === 0 ? homeIcon : waypointIcon}>
              <Popup>
                <strong>{wp.label || `WP ${i + 1}`}</strong><br />
                {parseFloat(wp.lat).toFixed(5)}, {parseFloat(wp.lng).toFixed(5)}<br />
                Altitude: {wp.altitude}m
              </Popup>
            </Marker>
          ))}

          {/* Dual polylines when comparison exists, single otherwise */}
          {hasComparison ? (<>
            <Polyline positions={astarRoute.path_points.map(p => [p.lat, p.lng])} color="#60a5fa" weight={3} />
            <Polyline positions={dijkstraRoute.path_points.map(p => [p.lat, p.lng])} color="#fb923c" weight={2} dashArray="8 5" />
          </>) : (
            singlePolylinePoints.length >= 2 && (
              <Polyline
                positions={singlePolylinePoints}
                color={route ? "#60a5fa" : "#f59e0b"}
                weight={route ? 3 : 2}
                dashArray={route ? null : "8 6"}
              />
            )
          )}

          {/* Replay drone marker */}
          {pathPoints.length > 0 && replayIndex > 0 && (
            <Marker position={[pathPoints[replayIndex].lat, pathPoints[replayIndex].lng]} icon={droneIcon}>
              <Popup>🚁 {distanceCovered.toFixed(3)} km · {replayProgress}%</Popup>
            </Marker>
          )}
        </MapContainer>

        {/* Map legend — shown when comparing */}
        {hasComparison && (
          <div style={{ position: "absolute", top: "14px", right: "14px", background: "rgba(10,16,32,0.92)", border: "1px solid #1e2d4a", borderRadius: "8px", padding: "10px 14px", zIndex: 998, fontSize: "11px", pointerEvents: "none" }}>
            <div style={{ color: "#64748b", marginBottom: "6px", textTransform: "uppercase", fontSize: "9px", letterSpacing: "1px" }}>Path Overlay</div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "5px" }}>
              <div style={{ width: "22px", height: "3px", background: "#60a5fa", borderRadius: "2px" }} />
              <span style={{ color: "#60a5fa" }}>A* Grid</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div style={{ width: "22px", height: "0", borderTop: "2px dashed #fb923c" }} />
              <span style={{ color: "#fb923c" }}>Dijkstra</span>
            </div>
          </div>
        )}

        {/* Analytics panel */}
        {showAnalytics && route && (
          <div style={s.analyticsPanel}>
            <div style={s.analyticsHeader}>
              <button style={s.analyticsTab(analyticsTab === "depth")} onClick={() => setAnalyticsTab("depth")}>
                📈 Altitude / Depth Profile
              </button>
              <button
                style={{ ...s.analyticsTab(analyticsTab === "compare"), opacity: hasComparison ? 1 : 0.4 }}
                onClick={() => hasComparison && setAnalyticsTab("compare")}
              >
                ⚖ Algorithm Comparison
              </button>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: "10px", color: "#475569" }}>
                {analyticsTab === "depth"   && "Green lines = waypoints · Altitude interpolated along path"}
                {analyticsTab === "compare" && hasComparison && `A*: ${astarRoute.total_distance_km}km · Dijkstra: ${dijkstraRoute.total_distance_km}km`}
              </span>
              <button style={{ ...s.btn("#374151"), marginLeft: "10px", padding: "3px 8px" }} onClick={() => setShowAnalytics(false)}>✕</button>
            </div>
            <div style={s.analyticsBody}>
              {analyticsTab === "depth" && (
                <DepthProfileChart profileData={depthProfileData} />
              )}
              {analyticsTab === "compare" && hasComparison && (
                <AlgorithmCompareChart astarRoute={astarRoute} dijkstraRoute={dijkstraRoute} />
              )}
              {analyticsTab === "compare" && !hasComparison && (
                <div style={{ color: "#475569", textAlign: "center", paddingTop: 60, fontSize: 12 }}>
                  Click "⚖ Compare A* vs Dijkstra" to generate comparison data
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Mode hint */}
      {(mode === "add" || mode === "zone") && activeMission && (() => {
        const hint = modeHints[mode];
        return (
          <div style={{ position: "fixed", top: "14px", left: "50%", transform: "translateX(-50%)", background: "#0f1629", border: `1px solid ${hint.border}`, borderRadius: "20px", padding: "7px 18px", color: hint.color, fontSize: "12px", zIndex: 9998, pointerEvents: "none" }}>
            {hint.text}
          </div>
        );
      })()}

      {/* Replay map overlay — bumps up when analytics panel is open */}
      {isReplaying && (
        <div style={{ position: "fixed", bottom: showAnalytics ? "258px" : "18px", left: "360px", background: "#071020", border: "1px solid #38bdf8", borderRadius: "8px", padding: "8px 14px", color: "#38bdf8", fontSize: "12px", zIndex: 9998, pointerEvents: "none", display: "flex", gap: "12px", alignItems: "center" }}>
          <span>🚁 Simulating</span>
          <span style={{ color: "#64748b" }}>|</span>
          <span>{distanceCovered.toFixed(3)} km</span>
          <span style={{ color: "#64748b" }}>|</span>
          <span>{replayProgress}%</span>
          {currentWaypoint && <><span style={{ color: "#64748b" }}>|</span><span>📍 {currentWaypoint}</span></>}
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", bottom: "18px", right: "18px", background: "#1e3a5f", border: "1px solid #2563eb", borderRadius: "8px", padding: "10px 16px", color: "#93c5fd", fontSize: "12px", zIndex: 9999, maxWidth: "300px" }}>
          {toast}
        </div>
      )}
    </div>
  );
}