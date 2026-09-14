-- ZenRadius License Registry schema (Cloudflare D1)

CREATE TABLE IF NOT EXISTS licenses (
  domain      TEXT PRIMARY KEY,
  serial      TEXT NOT NULL,
  issued_at   INTEGER NOT NULL,           -- epoch ms
  issued_by   TEXT,                       -- catatan bebas (mis. nama admin / perangkat)
  note        TEXT
);

CREATE TABLE IF NOT EXISTS installs (
  domain        TEXT PRIMARY KEY,
  serial        TEXT,                     -- serial yang terpasang di server pelanggan (boleh kosong)
  license_valid INTEGER NOT NULL DEFAULT 0,
  app_version   TEXT,
  node_version  TEXT,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  ip            TEXT,
  country       TEXT,
  hits          INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_installs_last_seen ON installs(last_seen);
CREATE INDEX IF NOT EXISTS idx_licenses_issued_at ON licenses(issued_at);
