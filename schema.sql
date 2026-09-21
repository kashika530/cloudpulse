-- schema.sql : the 4 tables. Runs on every start (IF NOT EXISTS makes that safe).

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS websites (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url                  TEXT NOT NULL,
  alert_email          TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING | UP | DOWN
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  failure_started_at   TEXT,                              -- when the current failure streak began
  incident_active      INTEGER NOT NULL DEFAULT 0,        -- 1 while an outage is ongoing (prevents repeat emails)
  last_checked_at      TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, url)
);

CREATE TABLE IF NOT EXISTS checks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  website_id       INTEGER NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  status           TEXT NOT NULL,                         -- UP | DOWN
  http_status_code INTEGER,
  response_time    INTEGER,                               -- milliseconds
  error_message    TEXT,
  checked_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checks_site_time ON checks (website_id, checked_at);

CREATE TABLE IF NOT EXISTS incidents (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  website_id       INTEGER NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  duration_seconds INTEGER,
  status           TEXT NOT NULL DEFAULT 'ONGOING',       -- ONGOING | RESOLVED
  error_message    TEXT
);
