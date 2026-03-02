const express = require("express");
const cors    = require("cors");
const morgan  = require("morgan");
const { Pool } = require("pg");
const axios   = require("axios");

const app         = express();
const PORT        = process.env.PORT        || 3001;
const PLANNER_URL = process.env.PLANNER_URL || "http://localhost:8000";

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(morgan("dev"));

// ── Database ───────────────────────────────────────────────────────────────
const pool = new Pool({
  host:     process.env.DB_HOST     || "localhost",
  user:     process.env.DB_USER     || "drone",
  password: process.env.DB_PASSWORD || "dronepass",
  database: process.env.DB_NAME     || "droneroute",
  port:     5432,
});

// ── Health ─────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "backend" });
});

// ── Missions ───────────────────────────────────────────────────────────────
app.get("/api/missions", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM missions ORDER BY created_at DESC");
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/missions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const mission   = await pool.query("SELECT * FROM missions WHERE id=$1", [id]);
    if (!mission.rows.length) return res.status(404).json({ error: "Mission not found" });

    const waypoints = await pool.query(
      "SELECT * FROM waypoints WHERE mission_id=$1 ORDER BY sequence_order", [id]
    );
    const routes = await pool.query(
      "SELECT * FROM routes WHERE mission_id=$1 ORDER BY computed_at DESC LIMIT 1", [id]
    );
    res.json({ ...mission.rows[0], waypoints: waypoints.rows, latest_route: routes.rows[0] || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/missions", async (req, res) => {
  try {
    const { name, description, waypoints = [] } = req.body;
    if (!name) return res.status(400).json({ error: "Mission name required" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const mRes = await client.query(
        "INSERT INTO missions (name, description) VALUES ($1,$2) RETURNING *",
        [name, description]
      );
      const mission = mRes.rows[0];
      for (let i = 0; i < waypoints.length; i++) {
        const wp = waypoints[i];
        await client.query(
          "INSERT INTO waypoints (mission_id,sequence_order,lat,lng,altitude,label) VALUES ($1,$2,$3,$4,$5,$6)",
          [mission.id, i+1, wp.lat, wp.lng, wp.altitude||50, wp.label||null]
        );
      }
      await client.query("COMMIT");
      res.status(201).json({ ...mission, waypoints });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally { client.release(); }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/missions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, status } = req.body;
    const { rows } = await pool.query(
      "UPDATE missions SET name=COALESCE($1,name), description=COALESCE($2,description), status=COALESCE($3,status), updated_at=NOW() WHERE id=$4 RETURNING *",
      [name, description, status, id]
    );
    if (!rows.length) return res.status(404).json({ error: "Mission not found" });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/missions/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM missions WHERE id=$1", [req.params.id]);
    res.json({ message: "Mission deleted" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Waypoints ──────────────────────────────────────────────────────────────
app.post("/api/missions/:id/waypoints", async (req, res) => {
  try {
    const { id } = req.params;
    const { lat, lng, altitude=50, label } = req.body;
    const countRes = await pool.query("SELECT COUNT(*) FROM waypoints WHERE mission_id=$1", [id]);
    const seq = parseInt(countRes.rows[0].count) + 1;
    const { rows } = await pool.query(
      "INSERT INTO waypoints (mission_id,sequence_order,lat,lng,altitude,label) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [id, seq, lat, lng, altitude, label]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/missions/:id/waypoints", async (req, res) => {
  try {
    await pool.query("DELETE FROM waypoints WHERE mission_id=$1", [req.params.id]);
    res.json({ message: "Waypoints cleared" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Route Planning ─────────────────────────────────────────────────────────
app.post("/api/missions/:id/plan", async (req, res) => {
  try {
    const { id } = req.params;
    const { algorithm = "astar", obstacles = [] } = req.body;

    const wpRes = await pool.query(
      "SELECT lat,lng,altitude,label FROM waypoints WHERE mission_id=$1 ORDER BY sequence_order", [id]
    );
    if (wpRes.rows.length < 2)
      return res.status(400).json({ error: "At least 2 waypoints required" });

    const planRes = await axios.post(
      `${PLANNER_URL}/plan`,
      { waypoints: wpRes.rows, algorithm, obstacles },
      { maxContentLength: Infinity, maxBodyLength: Infinity }
    );
    const plan = planRes.data;

    await pool.query(
      "INSERT INTO routes (mission_id,algorithm,total_distance,estimated_duration,path_json) VALUES ($1,$2,$3,$4,$5)",
      [id, plan.algorithm, plan.total_distance_km, plan.estimated_duration_min, JSON.stringify(plan)]
    );

    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.detail || err.message });
  }
});

app.get("/api/missions/:id/routes", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM routes WHERE mission_id=$1 ORDER BY computed_at DESC", [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅ DroneRoute backend on port ${PORT}`));
module.exports = app;