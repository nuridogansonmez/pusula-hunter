import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, 'datahunter.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    keyword TEXT NOT NULL,
    country TEXT DEFAULT 'Türkiye',
    city TEXT DEFAULT '',
    districts TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    total_found INTEGER DEFAULT 0,
    duration_seconds INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS businesses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    mobile TEXT DEFAULT '',
    website TEXT DEFAULT '',
    email TEXT DEFAULT '',
    address TEXT DEFAULT '',
    city TEXT DEFAULT '',
    district TEXT DEFAULT '',
    rating REAL DEFAULT 0,
    review_count INTEGER DEFAULT 0,
    category TEXT DEFAULT '',
    google_maps_url TEXT DEFAULT '',
    latitude REAL DEFAULT 0,
    longitude REAL DEFAULT 0,
    social_media TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_businesses_campaign ON businesses(campaign_id);
  CREATE INDEX IF NOT EXISTS idx_businesses_name ON businesses(name);
`);

// Safe migration: add notes column if not exists
try {
  const cols = db.prepare("PRAGMA table_info(businesses)").all();
  const hasNotes = cols.some(c => c.name === 'notes');
  if (!hasNotes) {
    db.exec("ALTER TABLE businesses ADD COLUMN notes TEXT DEFAULT ''");
  }
} catch (e) {
  // column may already exist
}

export default db;
