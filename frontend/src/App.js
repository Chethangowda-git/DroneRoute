import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  MapContainer, TileLayer, Marker, Polyline,
  Popup, useMapEvents, Circle, Polygon
} from "react-leaflet";
import L from "leaflet";
import axios from "axios";

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

// ── OSM Fetcher ──────────────────────────────────────────────────────────────
async function fetchOSMObstacles(waypoints) {
  if (waypoints.length < 1) return [];
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

// ── Map event handler ────────────────────────────────────────────────────────
function MapClickHandler({ mode, onWaypoint, onZone }) {
  useMapEvents({
    click: (e) => {
      if (mode === "add")  onWaypoint(e.latlng);
      if (mode === "zone") onZone(e.latlng);
    }
  });
  return null;
}

const STATUS_COLORS = { draft:"#f59e0b", active:"#22c55e", completed:"#60a5fa" };
const WP_COLORS     = ["#22c55e","#ef4444","#f59e0b","#a78bfa","#06b6d4","#fb7185"];
const ZONE_RADIUS_KM = 0.12;   // default no-fly circle = 120m radius

export default function App() {
  const [missions,      setMissions]      = useState([]);
  const [activeMission, setActiveMission] = useState(null);
  const [waypoints,     setWaypoints]     = useState([]);
  const [route,         setRoute]         = useState(null);
  const [algorithm,     setAlgorithm]     = useState("astar");
  const [missionName,   setMissionName]   = useState("");
  const [loading,       setLoading]       = useState(false);
  const [toast,         setToast]         = useState(null);
  const [mode,          setMode]          = useState("view");   // view | add | zone
  const [noFlyZones,    setNoFlyZones]    = useState([]);       // user-drawn circles
  const [osmData,       setOsmData]       = useState([]);       // fetched from OSM
  const [osmLoading,    setOsmLoading]    = useState(false);
  const zoneId = useRef(0);

  const showToast = (msg, dur = 3000) => { setToast(msg); setTimeout(() => setToast(null), dur); };

  const fetchMissions = useCallback(async () => {
    try { const r = await axios.get(`${API}/api/missions`); setMissions(r.data); } catch {}
  }, []);

  useEffect(() => { fetchMissions(); }, [fetchMissions]);

  const loadMission = async (m) => {
    try {
      const r = await axios.get(`${API}/api/missions/${m.id}`);
      setActiveMission(r.data);
      const wps = r.data.waypoints || [];
      setWaypoints(wps);
      setRoute(r.data.latest_route?.path_json || null);
      setNoFlyZones([]);
      setOsmData([]);
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
    showToast(`No-fly zone placed (r=${ZONE_RADIUS_KM * 1000}m) — click map to add more`);
  };

  const removeZone = (id) => setNoFlyZones(prev => prev.filter(z => z.id !== id));

  const clearWaypoints = async () => {
    if (!activeMission) return;
    await axios.delete(`${API}/api/missions/${activeMission.id}/waypoints`);
    setWaypoints([]); setRoute(null); setOsmData([]);
  };

  // Fetch OSM data for current waypoint bounding box
  const handleFetchOSM = async () => {
    if (waypoints.length < 1) return showToast("Add waypoints first");
    setOsmLoading(true);
    showToast("Fetching buildings & parks from OpenStreetMap...", 5000);
    const data = await fetchOSMObstacles(waypoints);
    setOsmData(data);
    showToast(`Loaded ${data.length} obstacles from OSM`);
    setOsmLoading(false);
  };

  // Plan route — sends both user zones + OSM polygons as obstacles
  const planRoute = async () => {
    if (!activeMission || waypoints.length < 2) return showToast("Need at least 2 waypoints");
    setLoading(true);
    try {
      // Build obstacle list
      const circleObstacles = noFlyZones.map(z => ({
        type:       "circle",
        center_lat: z.lat,
        center_lng: z.lng,
        radius_km:  z.radius_km,
      }));
      const polyObstacles = osmData.map(o => ({
        type:   "polygon",
        points: o.points,
      }));
      const obstacles = [...circleObstacles, ...polyObstacles];

      const r = await axios.post(`${API}/api/missions/${activeMission.id}/plan`, {
        algorithm,
        obstacles,
      });
      setRoute(r.data);
      const obs = r.data.obstacle_count;
      showToast(`Route computed (${algorithm.toUpperCase()}) · ${r.data.total_distance_km}km · ${obs} obstacles avoided`);
    } catch (err) {
      showToast(err.response?.data?.error || "Planning failed");
    } finally { setLoading(false); }
  };

  // Map polyline — use detailed grid path if available
  const polylinePoints = route?.path_points
    ? route.path_points.map(p => [p.lat, p.lng])
    : waypoints.map(wp => [parseFloat(wp.lat), parseFloat(wp.lng)]);

  const mapCenter = waypoints.length
    ? [parseFloat(waypoints[0].lat), parseFloat(waypoints[0].lng)]
    : [42.3601, -71.0589];

  // ── Styles ────────────────────────────────────────────────────────────────
  const s = {
    app:      { display:"flex", height:"100vh", overflow:"hidden" },
    sidebar:  { width:"340px", background:"#0f1629", borderRight:"1px solid #1e2d4a", display:"flex", flexDirection:"column", overflow:"hidden" },
    header:   { padding:"16px 18px", background:"linear-gradient(135deg,#1a2744,#0d1b35)", borderBottom:"1px solid #1e2d4a" },
    title:    { fontSize:"17px", fontWeight:700, color:"#60a5fa", letterSpacing:"2px" },
    subtitle: { fontSize:"10px", color:"#475569", marginTop:"3px" },
    section:  { padding:"12px 14px", borderBottom:"1px solid #1e2d4a" },
    label:    { fontSize:"10px", color:"#64748b", textTransform:"uppercase", letterSpacing:"1px", marginBottom:"7px" },
    input:    { width:"100%", background:"#1e2d4a", border:"1px solid #2d4168", borderRadius:"6px", padding:"7px 10px", color:"#e2e8f0", fontSize:"13px", marginBottom:"7px", outline:"none" },
    btn:      (bg, full) => ({ width: full?"100%":"auto", padding: full?"9px":"7px 12px", background:bg, border:"none", borderRadius:"6px", color:"#fff", fontSize:"12px", fontWeight:600, cursor:"pointer" }),
    btnGhost: (active) => ({ padding:"7px 0", background: active?"#1e3a5f":"transparent", border:"1px solid #2d4168", borderRadius:"5px", color: active?"#93c5fd":"#94a3b8", fontSize:"12px", cursor:"pointer", flex:1 }),
    select:   { background:"#1e2d4a", border:"1px solid #2d4168", borderRadius:"6px", padding:"7px 10px", color:"#e2e8f0", fontSize:"12px", width:"100%", marginBottom:"7px" },
    wpList:   { flex:1, overflowY:"auto", padding:"6px 12px" },
    wpItem:   { display:"flex", alignItems:"center", gap:"8px", padding:"7px", background:"#1a2744", borderRadius:"6px", marginBottom:"4px", fontSize:"12px" },
    badge:    (color) => ({ width:"20px", height:"20px", borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", fontSize:"10px", fontWeight:700, flexShrink:0, background:color, color:"#000" }),
    stats:    { display:"grid", gridTemplateColumns:"1fr 1fr", gap:"6px", padding:"12px" },
    statBox:  { background:"#1a2744", borderRadius:"7px", padding:"9px", textAlign:"center" },
    statVal:  { fontSize:"17px", fontWeight:700, color:"#60a5fa" },
    statKey:  { fontSize:"10px", color:"#64748b", marginTop:"2px" },
    mItem:    (active) => ({ padding:"7px 10px", cursor:"pointer", borderRadius:"6px", marginBottom:"3px", fontSize:"13px", display:"flex", alignItems:"center", gap:"8px", background: active?"#1e3a5f":"#1a2744", border: active?"1px solid #2563eb":"1px solid transparent" }),
    dot:      (s) => ({ width:"7px", height:"7px", borderRadius:"50%", background:STATUS_COLORS[s]||"#94a3b8", flexShrink:0 }),
    zoneItem: { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"5px 8px", background:"#2d1515", borderRadius:"5px", marginBottom:"3px", fontSize:"11px" },
  };

  const modeHints = {
    add:  { color:"#4ade80", border:"#22c55e", text:"✦ Click map to place a waypoint" },
    zone: { color:"#fb923c", border:"#f97316", text:"⊘ Click map to place a no-fly zone" },
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
          <div style={{ overflowY:"auto", maxHeight:"130px", marginBottom:"8px" }}>
            {missions.map(m => (
              <div key={m.id} style={s.mItem(activeMission?.id===m.id)} onClick={() => loadMission(m)}>
                <div style={s.dot(m.status)} />
                <span style={{ flex:1 }}>{m.name}</span>
                <span style={{ fontSize:"10px", color:"#475569", textTransform:"uppercase" }}>{m.status}</span>
              </div>
            ))}
          </div>
          <div style={{ display:"flex", gap:"5px" }}>
            <input style={{ ...s.input, marginBottom:0, flex:1 }}
              placeholder="New mission name..."
              value={missionName}
              onChange={e => setMissionName(e.target.value)}
              onKeyDown={e => e.key==="Enter" && createMission()}
            />
            <button style={s.btn("#2563eb")} onClick={createMission}>+</button>
          </div>
        </div>

        {activeMission && (<>
          {/* Mode buttons */}
          <div style={s.section}>
            <div style={s.label}>Mode</div>
            <div style={{ display:"flex", gap:"5px" }}>
              <button style={s.btnGhost(mode==="view")} onClick={() => setMode("view")}>View</button>
              <button style={s.btnGhost(mode==="add")}  onClick={() => setMode("add")}>+ Waypoint</button>
              <button style={{ ...s.btnGhost(mode==="zone"), color: mode==="zone"?"#fb923c":"#94a3b8", background: mode==="zone"?"#2d1515":"transparent" }}
                onClick={() => setMode("zone")}>⊘ Zone</button>
            </div>
          </div>

          {/* OSM + Algorithm + Plan */}
          <div style={s.section}>
            <div style={s.label}>Obstacles</div>
            <div style={{ display:"flex", gap:"5px", marginBottom:"8px" }}>
              <button style={{ ...s.btn("#065f46"), flex:1, opacity: osmLoading?0.6:1 }}
                onClick={handleFetchOSM} disabled={osmLoading}>
                {osmLoading ? "Fetching..." : "🗺 Fetch OSM Buildings & Parks"}
              </button>
            </div>
            {(osmData.length > 0 || noFlyZones.length > 0) && (
              <div style={{ fontSize:"11px", color:"#94a3b8", marginBottom:"6px" }}>
                {osmData.length} OSM polygons · {noFlyZones.length} drawn zones
              </div>
            )}
            {noFlyZones.length > 0 && (
              <div style={{ maxHeight:"80px", overflowY:"auto" }}>
                {noFlyZones.map(z => (
                  <div key={z.id} style={s.zoneItem}>
                    <span style={{ color:"#fb923c" }}>⊘ Zone {z.id+1}</span>
                    <span style={{ color:"#64748b" }}>{z.lat.toFixed(4)}, {z.lng.toFixed(4)}</span>
                    <button style={s.btn("#7f1d1d")} onClick={() => removeZone(z.id)}>×</button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ ...s.label, marginTop:"8px", marginBottom:"6px", fontSize:"10px", color:"#64748b", textTransform:"uppercase", letterSpacing:"1px" }}>Algorithm</div>
            <select style={s.select} value={algorithm} onChange={e => setAlgorithm(e.target.value)}>
              <option value="astar">A* Grid — Obstacle-aware (recommended)</option>
              <option value="dijkstra">Dijkstra — Waypoint shortest path</option>
            </select>
            <button style={s.btn("#2563eb", true)} onClick={planRoute} disabled={loading}>
              {loading ? "Computing route..." : "⚡ Plan Route"}
            </button>
          </div>

          {/* Waypoints list */}
          <div style={{ padding:"6px 14px 3px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <span style={{ fontSize:"10px", color:"#64748b", textTransform:"uppercase", letterSpacing:"1px" }}>Waypoints ({waypoints.length})</span>
            {waypoints.length > 0 && (
              <button style={s.btn("#7f1d1d")} onClick={clearWaypoints}>Clear All</button>
            )}
          </div>
          <div style={s.wpList}>
            {waypoints.map((wp, i) => (
              <div key={wp.id||i} style={s.wpItem}>
                <div style={s.badge(WP_COLORS[i%WP_COLORS.length])}>{i+1}</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontWeight:600, color:"#e2e8f0" }}>{wp.label||`WP ${i+1}`}</div>
                  <div style={{ color:"#475569", fontSize:"11px" }}>{parseFloat(wp.lat).toFixed(4)}, {parseFloat(wp.lng).toFixed(4)} · {wp.altitude}m</div>
                </div>
              </div>
            ))}
            {waypoints.length === 0 && (
              <div style={{ color:"#475569", textAlign:"center", padding:"16px 0", fontSize:"12px" }}>
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
              <div style={s.statBox}><div style={{ ...s.statVal, fontSize:"13px", color: route.obstacle_count>0?"#fb923c":"#a78bfa" }}>{route.obstacle_count > 0 ? `${route.obstacle_count} avoided` : route.algorithm.toUpperCase()}</div><div style={s.statKey}>{route.obstacle_count > 0 ? "obstacles" : "algorithm"}</div></div>
            </div>
          )}
        </>)}

        {!activeMission && (
          <div style={{ padding:"24px", color:"#475569", fontSize:"13px", textAlign:"center" }}>
            Select or create a mission to begin
          </div>
        )}
      </div>

      {/* ── Map ── */}
      <MapContainer center={mapCenter} zoom={14} style={{ flex:1, height:"100%" }}>
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='© <a href="https://www.openstreetmap.org">OpenStreetMap</a>'
        />
        <MapClickHandler
          mode={mode}
          onWaypoint={handleWaypointClick}
          onZone={handleZoneClick}
        />

        {/* OSM polygons — buildings grey, greenspace green */}
        {osmData.map((obs, i) => (
          <Polygon
            key={`osm-${i}`}
            positions={obs.points.map(p => [p.lat, p.lng])}
            pathOptions={{
              color:       obs.kind==="building" ? "#94a3b8" : "#4ade80",
              fillColor:   obs.kind==="building" ? "#1e293b" : "#14532d",
              fillOpacity: 0.55,
              weight:      1,
            }}
          />
        ))}

        {/* User-drawn no-fly zones */}
        {noFlyZones.map(z => (
          <Circle
            key={z.id}
            center={[z.lat, z.lng]}
            radius={z.radius_km * 1000}
            pathOptions={{ color:"#f97316", fillColor:"#7c2d12", fillOpacity:0.4, weight:2 }}
          >
            <Popup>
              <strong style={{ color:"#f97316" }}>⊘ No-Fly Zone</strong><br/>
              Center: {z.lat.toFixed(5)}, {z.lng.toFixed(5)}<br/>
              Radius: {z.radius_km*1000}m<br/>
              <button onClick={() => removeZone(z.id)} style={{ marginTop:"4px", padding:"2px 8px", background:"#dc2626", border:"none", borderRadius:"4px", color:"#fff", cursor:"pointer" }}>Remove</button>
            </Popup>
          </Circle>
        ))}

        {/* Waypoint markers */}
        {waypoints.map((wp, i) => (
          <Marker key={wp.id||i} position={[parseFloat(wp.lat), parseFloat(wp.lng)]} icon={i===0 ? homeIcon : waypointIcon}>
            <Popup>
              <strong>{wp.label||`WP ${i+1}`}</strong><br/>
              {parseFloat(wp.lat).toFixed(5)}, {parseFloat(wp.lng).toFixed(5)}<br/>
              Altitude: {wp.altitude}m
            </Popup>
          </Marker>
        ))}

        {/* Route polyline — follows grid path around obstacles */}
        {polylinePoints.length >= 2 && (
          <Polyline
            positions={polylinePoints}
            color={route ? "#60a5fa" : "#f59e0b"}
            weight={route ? 3 : 2}
            dashArray={route ? null : "8 6"}
          />
        )}
      </MapContainer>

      {/* Mode hint overlay */}
      {(mode==="add" || mode==="zone") && activeMission && (() => {
        const hint = modeHints[mode];
        return (
          <div style={{ position:"fixed", top:"14px", left:"50%", transform:"translateX(-50%)", background:"#0f1629", border:`1px solid ${hint.border}`, borderRadius:"20px", padding:"7px 18px", color:hint.color, fontSize:"12px", zIndex:9998, pointerEvents:"none" }}>
            {hint.text}
          </div>
        );
      })()}

      {toast && (
        <div style={{ position:"fixed", bottom:"18px", right:"18px", background:"#1e3a5f", border:"1px solid #2563eb", borderRadius:"8px", padding:"10px 16px", color:"#93c5fd", fontSize:"12px", zIndex:9999, maxWidth:"300px" }}>
          {toast}
        </div>
      )}
    </div>
  );
}