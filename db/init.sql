CREATE TABLE IF NOT EXISTS missions (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(50) DEFAULT 'draft',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS waypoints (
    id SERIAL PRIMARY KEY,
    mission_id INTEGER REFERENCES missions(id) ON DELETE CASCADE,
    sequence_order INTEGER NOT NULL,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    altitude DOUBLE PRECISION DEFAULT 50.0,
    label VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS routes (
    id SERIAL PRIMARY KEY,
    mission_id INTEGER REFERENCES missions(id) ON DELETE CASCADE,
    algorithm VARCHAR(50) NOT NULL,
    total_distance DOUBLE PRECISION,
    estimated_duration DOUBLE PRECISION,
    path_json JSONB,
    computed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_waypoints_mission ON waypoints(mission_id);
CREATE INDEX idx_routes_mission ON routes(mission_id);

-- Seed demo data
INSERT INTO missions (name, description, status) VALUES
('Urban Delivery Alpha', 'City center package delivery route', 'active'),
('Search & Rescue Grid', 'Mountain sector sweep pattern', 'draft');

INSERT INTO waypoints (mission_id, sequence_order, lat, lng, altitude, label) VALUES
(1, 1, 42.3601, -71.0589, 80, 'Depot'),
(1, 2, 42.3651, -71.0489, 60, 'Drop Point A'),
(1, 3, 42.3701, -71.0389, 60, 'Drop Point B');