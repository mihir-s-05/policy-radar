CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX sessions_owner ON sessions(owner_hash, created_at);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
  sources_json TEXT, steps_json TEXT, model TEXT, request_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  UNIQUE(session_id, request_id, role)
);
CREATE INDEX messages_session ON messages(session_id,id);
CREATE TABLE requests (
  request_id TEXT NOT NULL, owner_hash TEXT NOT NULL, session_id TEXT NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  PRIMARY KEY(owner_hash, request_id),
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
CREATE TABLE budgets (
  bucket TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT (unixepoch()+172800)
);
CREATE INDEX budgets_expiry ON budgets(expires_at);
CREATE TABLE upstream_cache (
  cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX cache_expiry ON upstream_cache(expires_at);
CREATE INDEX requests_created ON requests(created_at);
