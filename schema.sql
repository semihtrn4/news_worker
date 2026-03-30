CREATE TABLE IF NOT EXISTS news (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  link TEXT,
  pub_date INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pub_date ON news(pub_date DESC);
CREATE INDEX IF NOT EXISTS idx_source ON news(source);