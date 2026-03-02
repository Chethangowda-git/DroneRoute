# ⬡ DroneRoute — Autonomous Mission Planner

> Full-stack drone mission planning application with obstacle-aware A\* pathfinding, interactive map-based waypoint selection, and real-world obstacle avoidance using OpenStreetMap data.

![Tech Stack](https://img.shields.io/badge/React-18-61DAFB?logo=react) ![FastAPI](https://img.shields.io/badge/FastAPI-2.0-009688?logo=fastapi) ![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=node.js) ![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15-4169E1?logo=postgresql) ![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker)

---

## Table of Contents

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Features](#features)
- [Project Structure](#project-structure)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
- [Path Planning Algorithms](#path-planning-algorithms)
- [Obstacle Avoidance](#obstacle-avoidance)
- [Running Tests](#running-tests)
- [Resume Bullets](#resume-bullets)

---

## Overview

DroneRoute is a full-stack autonomous drone mission planner that lets users create missions, drop waypoints on an interactive map, fetch real-world obstacle data (buildings, parks, forests) from OpenStreetMap, draw custom no-fly zones, and compute optimized flight paths that physically route around all obstacles using grid-based A\* pathfinding.

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | React 18 + React-Leaflet | Interactive map UI, waypoint management |
| API Gateway | Node.js + Express | RESTful API, DB transactions, request routing |
| Path Planner | FastAPI (Python) | A\*, Dijkstra, grid pathfinding, TSP ordering |
| Database | PostgreSQL 15 | Mission, waypoint, and route persistence |
| Map Tiles | OpenStreetMap + Leaflet.js | Satellite-accurate base map |
| Obstacle Data | Overpass API (OSM) | Real-world buildings, parks, forests |
| Containerization | Docker + Docker Compose | 4-service orchestration |
| Testing | Pytest | 40+ test scenarios |

---

## Architecture

```
┌─────────────────────┐   HTTP/REST   ┌──────────────────────┐
│   React Frontend    │ ────────────► │  Node.js Backend     │
│   (Leaflet Map)     │               │  (Express Gateway)   │
│   :3000             │               │  :3001               │
└─────────────────────┘               └──────────┬───────────┘
                                                 │ HTTP
                                      ┌──────────▼───────────┐
                                      │  FastAPI Planner     │
                                      │  A* Grid / Dijkstra  │
                                      │  :8000               │
                                      └──────────┬───────────┘
                                                 │
                                      ┌──────────▼───────────┐
                                      │    PostgreSQL 15      │
                                      │  missions/waypoints  │
                                      │  /routes             │
                                      │  :5432               │
                                      └──────────────────────┘

External:
  React ──► Overpass API (OpenStreetMap) — fetches buildings & parks
```

---

## Features

### Mission Management
- Create, load, update, and delete named missions
- Missions persist across sessions in PostgreSQL
- Status tracking: `draft` → `active` → `completed`

### Interactive Map
- Click-to-drop waypoints anywhere on the globe
- OpenStreetMap base tiles with Leaflet.js
- Color-coded markers (green = home, red = waypoints)
- Popup details on each marker (lat, lng, altitude)

### Obstacle Avoidance
- **OSM Fetch** — pulls buildings, parks, forests, and greenspaces from OpenStreetMap Overpass API for the current mission bounding box
- **No-Fly Zones** — draw custom circular restricted zones directly on the map
- Obstacles rendered as map overlays (grey = buildings, green = parks, orange = no-fly zones)

### Path Planning
- **Grid-based A\*** — overlays a fine grid (~28m resolution) over the mission area, marks obstacle cells as blocked, computes heuristic path that curves around everything
- **Dijkstra** — exhaustive shortest path on waypoint graph (no-obstacle fallback)
- **TSP nearest-neighbor** ordering for multi-stop missions (3+ waypoints)
- Detailed `path_points` array returned for accurate polyline rendering on the map

### Route Persistence
- Every computed route saved to PostgreSQL with algorithm, distance, duration, and full path JSON
- Route history queryable per mission

---

## Project Structure

```
droneroute/
├── docker-compose.yml           # 4-service orchestration
│
├── db/
│   └── init.sql                 # Schema creation + seed data
│
├── frontend/                    # React application
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js             # React entry point
│       └── App.js               # Map UI, mission controls, OSM fetch
│
├── backend/                     # Node.js API gateway
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       └── index.js             # Express REST endpoints
│
└── planner/                     # FastAPI path planning service
    ├── Dockerfile
    ├── requirements.txt
    ├── app/
    │   ├── __init__.py
    │   └── main.py              # A*, Dijkstra, grid planner, TSP, REST
    └── tests/
        ├── __init__.py
        └── test_planner.py      # 40+ pytest scenarios
```

---

## Quick Start

### Prerequisites
- Docker Desktop installed and running (Mac/Windows/Linux)

### Run the full stack

```bash
git clone https://github.com/your-username/droneroute.git
cd droneroute
docker compose up --build
```

First run takes ~3 minutes (downloading images + installing dependencies). Subsequent starts are fast.

### Access the services

| Service | URL | Description |
|---------|-----|-------------|
| Frontend | http://localhost:3000 | React map UI |
| Backend | http://localhost:3001 | Node.js REST API |
| Planner | http://localhost:8000 | FastAPI path planner |
| Swagger Docs | http://localhost:8000/docs | Interactive API docs |
| PostgreSQL | localhost:5432 | DB (user: drone / pass: dronepass) |

### Stop everything

```bash
docker compose down          # stop containers
docker compose down -v       # stop + delete DB volume (fresh start)
```

---

## API Reference

### Backend — Node.js `:3001`

#### Missions

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/missions` | List all missions |
| POST | `/api/missions` | Create a new mission |
| GET | `/api/missions/:id` | Get mission + waypoints + latest route |
| PUT | `/api/missions/:id` | Update mission name/status |
| DELETE | `/api/missions/:id` | Delete mission and all data |

#### Waypoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/missions/:id/waypoints` | Add a waypoint to a mission |
| DELETE | `/api/missions/:id/waypoints` | Clear all waypoints for a mission |

#### Route Planning

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/missions/:id/plan` | Compute route (calls FastAPI planner) |
| GET | `/api/missions/:id/routes` | Get route history for a mission |

**Plan route request body:**
```json
{
  "algorithm": "astar",
  "obstacles": [
    { "type": "circle", "center_lat": 42.36, "center_lng": -71.05, "radius_km": 0.12 },
    { "type": "polygon", "points": [{"lat": 42.36, "lng": -71.05}, ...] }
  ]
}
```

### Planner — FastAPI `:8000`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Service health check |
| GET | `/algorithms` | List available algorithms |
| POST | `/plan` | Compute path from waypoints + obstacles |
| GET | `/docs` | Swagger UI |

---

## Path Planning Algorithms

### Grid-based A\* (recommended)

When obstacles are present, the planner overlays a fine grid (~28m per cell) over the mission bounding box. Each cell intersecting an obstacle is marked blocked. A\* searches the grid using haversine distance as the heuristic, producing a path that physically routes around all obstacles.

```
Start ──►  □ □ □ ■ ■ □ □
           □ □ □ ■ ■ □ □   ■ = blocked (building/park/no-fly zone)
           □ □ □ ■ ■ □ □   □ = traversable
           □ □ □ ─►─►─►──► End
```

**Complexity:** O(E log V) where V = grid cells

### Dijkstra (waypoint graph)

Classic exhaustive shortest-path on the fully-connected waypoint graph. Guaranteed optimal but operates only on waypoints — does not route around mid-path obstacles. Used as a fallback when no obstacles are defined.

**Complexity:** O((V + E) log V)

### Nearest-Neighbor TSP

For missions with 3+ waypoints, a greedy nearest-neighbor heuristic determines the optimal visitation order before applying the path planning algorithm. Always starts from waypoint 0 (home/depot).

---

## Obstacle Avoidance

### OpenStreetMap Integration

Click **🗺 Fetch OSM Buildings & Parks** to query the [Overpass API](https://overpass-api.de) for the current mission bounding box. Fetches:

- `building=*` — all structures
- `leisure=park` — public parks
- `landuse=forest` / `natural=wood` — wooded areas
- `landuse=grass` — open grassland

Fetched polygons are rendered on the map and sent as obstacles to the planner.

### No-Fly Zones

Switch to **⊘ Zone** mode and click anywhere on the map to place a circular no-fly zone (120m radius by default). Zones are rendered as orange circles and can be removed individually via popup.

---

## Running Tests

```bash
# Run all 40+ tests inside the Docker container
docker exec droneroute_planner pytest tests/test_planner.py -v

# With coverage report
docker exec droneroute_planner pytest tests/test_planner.py -v --cov=app

# Run locally (requires Python 3.11+)
cd planner
pip install -r requirements.txt
pytest tests/test_planner.py -v
```

### Test Coverage

| Class | Tests | What's Covered |
|-------|-------|---------------|
| `TestHaversine` | 8 | Distance accuracy, symmetry, edge cases |
| `TestBearing` | 5 | N/S/E/W compass directions, range validation |
| `TestGraph` | 5 | Node count, self-loops, connectivity, weights |
| `TestDijkstra` | 5 | Path start/end, list format, minimum length |
| `TestAStar` | 4 | Heuristic consistency, matches Dijkstra |
| `TestTSP` | 4 | All indices visited, no duplicates, start node |
| `TestAPI` | 10 | Plan endpoint, error handling, response schema |

---

## Environment Variables

### Backend (Node.js)
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Express server port |
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_USER` | `drone` | PostgreSQL user |
| `DB_PASSWORD` | `dronepass` | PostgreSQL password |
| `DB_NAME` | `droneroute` | PostgreSQL database name |
| `PLANNER_URL` | `http://localhost:8000` | FastAPI planner URL |

### Planner (FastAPI)
| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | PostgreSQL connection string |

---

## Resume Bullets

```
DroneRoute — Autonomous Drone Mission Planner                    React · Node.js · FastAPI · PostgreSQL · Docker

• Built full-stack drone mission planner with React, Node.js, FastAPI, and PostgreSQL,
  orchestrated via Docker Compose across 4 microservices

• Implemented grid-based A* and Dijkstra path planning algorithms with real-world obstacle
  avoidance using OpenStreetMap Overpass API (buildings, parks, forests)

• Enabled interactive waypoint selection and no-fly zone drawing via Leaflet.js map integration

• Validated with 40+ Pytest test scenarios covering haversine math, graph traversal,
  TSP ordering, and REST API endpoints following SDLC practices
```

---

## License

MIT — free to use, modify, and showcase in your portfolio.
