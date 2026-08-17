import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config, BIN_DEFAULTS } from "./config.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bins (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  location              TEXT,
  token_hash            TEXT NOT NULL,

  -- calibration: measured once per bin, never hardcoded
  empty_distance_mm     REAL NOT NULL,
  full_distance_mm      REAL NOT NULL,

  -- alerting behaviour
  full_threshold_pct    REAL NOT NULL,
  clear_threshold_pct   REAL NOT NULL,
  consecutive_required  INTEGER NOT NULL,
  repeat_alert_hours    REAL,
  offline_after_hours   REAL,
  low_battery_v         REAL,
  high_temp_c           REAL,

  -- live state
  state                 TEXT NOT NULL DEFAULT 'OK',
  state_changed_at      INTEGER,
  last_alert_at         INTEGER,
  last_seen_at          INTEGER,
  last_level_pct        REAL,
  consecutive_high      INTEGER NOT NULL DEFAULT 0,
  consecutive_low       INTEGER NOT NULL DEFAULT 0,
  online                INTEGER NOT NULL DEFAULT 1,
  battery_alerted       INTEGER NOT NULL DEFAULT 0,
  temp_alerted          INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS readings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  bin_id        TEXT NOT NULL REFERENCES bins(id) ON DELETE CASCADE,
  distance_mm   REAL NOT NULL,
  level_pct     REAL NOT NULL,
  battery_v     REAL,
  temperature_c REAL,
  rssi          INTEGER,
  received_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_readings_bin_time ON readings(bin_id, received_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bin_id     TEXT NOT NULL REFERENCES bins(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  message    TEXT NOT NULL,
  level_pct  REAL,
  notified   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(created_at DESC);
`;

export function openDb(dbPath = config.dbPath) {
  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

/** Constant-time compare so token checks do not leak length or content. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createBin(db, input) {
  const id = input.id || `bin-${crypto.randomBytes(4).toString("hex")}`;
  // Shown to the operator exactly once; only the hash is stored.
  const token = crypto.randomBytes(24).toString("base64url");
  const settings = { ...BIN_DEFAULTS, ...stripUndefined(input) };

  if (!(settings.empty_distance_mm > settings.full_distance_mm)) {
    throw new ValidationError(
      "empty_distance_mm must be greater than full_distance_mm",
    );
  }
  if (!(settings.clear_threshold_pct < settings.full_threshold_pct)) {
    throw new ValidationError(
      "clear_threshold_pct must be below full_threshold_pct - the gap is the hysteresis band",
    );
  }

  db.prepare(
    `INSERT INTO bins (id, name, location, token_hash, empty_distance_mm, full_distance_mm,
                       full_threshold_pct, clear_threshold_pct, consecutive_required,
                       repeat_alert_hours, offline_after_hours, low_battery_v, high_temp_c,
                       created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.name || id,
    input.location ?? null,
    hashToken(token),
    settings.empty_distance_mm,
    settings.full_distance_mm,
    settings.full_threshold_pct,
    settings.clear_threshold_pct,
    settings.consecutive_required,
    settings.repeat_alert_hours,
    settings.offline_after_hours,
    settings.low_battery_v,
    settings.high_temp_c,
    Date.now(),
  );

  return { bin: getBin(db, id), token };
}

export const getBin = (db, id) => db.prepare("SELECT * FROM bins WHERE id = ?").get(id) ?? null;

export const listBins = (db) => db.prepare("SELECT * FROM bins ORDER BY name").all();

/** Fields an admin may change after registration. Calibration is included. */
const UPDATABLE = new Set([
  "name",
  "location",
  "empty_distance_mm",
  "full_distance_mm",
  "full_threshold_pct",
  "clear_threshold_pct",
  "consecutive_required",
  "repeat_alert_hours",
  "offline_after_hours",
  "low_battery_v",
  "high_temp_c",
]);

export function updateBin(db, id, patch) {
  const fields = Object.keys(patch).filter((k) => UPDATABLE.has(k));
  if (fields.length === 0) return getBin(db, id);

  const merged = { ...getBin(db, id), ...patch };
  if (!(merged.empty_distance_mm > merged.full_distance_mm)) {
    throw new ValidationError("empty_distance_mm must be greater than full_distance_mm");
  }
  if (!(merged.clear_threshold_pct < merged.full_threshold_pct)) {
    throw new ValidationError("clear_threshold_pct must be below full_threshold_pct");
  }

  const set = fields.map((f) => `${f} = ?`).join(", ");
  db.prepare(`UPDATE bins SET ${set} WHERE id = ?`).run(...fields.map((f) => patch[f]), id);
  return getBin(db, id);
}

/** Apply a state patch produced by the pure logic in fill.js. */
export function patchBinState(db, id, patch) {
  const fields = Object.keys(patch);
  if (fields.length === 0) return;
  const set = fields.map((f) => `${f} = ?`).join(", ");
  db.prepare(`UPDATE bins SET ${set} WHERE id = ?`).run(...fields.map((f) => patch[f]), id);
}

export function insertReading(db, binId, r, levelPct, at) {
  db.prepare(
    `INSERT INTO readings (bin_id, distance_mm, level_pct, battery_v, temperature_c, rssi, received_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(
    binId,
    r.distanceMm,
    levelPct,
    r.batteryV ?? null,
    r.temperatureC ?? null,
    r.rssi ?? null,
    at,
  );
}

export function insertEvent(db, binId, event, levelPct, at) {
  const info = db
    .prepare(
      `INSERT INTO events (bin_id, type, message, level_pct, created_at) VALUES (?,?,?,?,?)`,
    )
    .run(binId, event.type, event.message, levelPct ?? null, at);
  return Number(info.lastInsertRowid);
}

export const markEventNotified = (db, eventId) =>
  db.prepare("UPDATE events SET notified = 1 WHERE id = ?").run(eventId);

export const recentReadings = (db, binId, limit = 100) =>
  db
    .prepare("SELECT * FROM readings WHERE bin_id = ? ORDER BY received_at DESC LIMIT ?")
    .all(binId, limit);

export const recentEvents = (db, limit = 50) =>
  db
    .prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT ?")
    .all(limit);

export const deleteBin = (db, id) => db.prepare("DELETE FROM bins WHERE id = ?").run(id);

export class ValidationError extends Error {}

function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
