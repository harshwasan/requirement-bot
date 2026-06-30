-- Requirements posted by customers (someone looking for a product)
CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  raw_text TEXT NOT NULL,
  source TEXT NOT NULL,           -- 'whatsapp' | 'telegram'
  group_id TEXT,
  group_name TEXT,
  sender TEXT,
  timestamp INTEGER NOT NULL,
  status TEXT DEFAULT 'pending'   -- pending | processing | done | failed
);

-- Results found by the agent for a requirement
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES requirements(id),
  dealer_name TEXT,
  link TEXT,
  price TEXT,
  details TEXT,
  confidence TEXT,                -- high | medium | low
  source TEXT,                    -- 'external_site' | 'internal_listing'
  found_at INTEGER NOT NULL,
  last_verified INTEGER,
  still_available INTEGER DEFAULT 1
);

-- Product listings posted by sellers (domain-flexible schema)
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL DEFAULT 'used_cars',
  source TEXT NOT NULL,           -- 'whatsapp' | 'telegram'
  group_id TEXT,
  group_name TEXT,
  sender TEXT,
  raw_text TEXT,
  image_paths TEXT,               -- JSON array of local saved image paths

  -- Used cars specific fields (NULL for other domains)
  make TEXT,                      -- Toyota, Honda, Suzuki...
  model TEXT,                     -- Corolla, Civic, Alto...
  variant TEXT,                   -- VX, GLI, 1.8, CVT...
  year INTEGER,
  fuel_type TEXT,                 -- Petrol, Diesel, CNG, Hybrid, Electric
  color TEXT,
  km_driven INTEGER,
  price TEXT,                     -- stored as text ("25 lakh", "negotiable")
  condition_rating TEXT,          -- Excellent, Good, Fair, Poor
  location TEXT,
  contact TEXT,

  -- Flexible JSON catch-all for any extra details the agent finds
  extra_details TEXT,             -- JSON object

  posted_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_requirements_status ON requirements(status);
CREATE INDEX IF NOT EXISTS idx_requirements_timestamp ON requirements(timestamp);
CREATE INDEX IF NOT EXISTS idx_results_requirement_id ON results(requirement_id);
CREATE INDEX IF NOT EXISTS idx_listings_domain ON listings(domain);
CREATE INDEX IF NOT EXISTS idx_listings_make_model ON listings(make, model);
CREATE INDEX IF NOT EXISTS idx_listings_posted_at ON listings(posted_at);
