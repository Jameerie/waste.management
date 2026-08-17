import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Node 22 can load a .env file natively - no dotenv dependency needed.
const envFile = path.join(ROOT, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: num(process.env.PORT, 3000),
  dbPath: path.resolve(ROOT, process.env.DB_PATH || "./data/waste.db"),
  adminToken: process.env.ADMIN_TOKEN || "",
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID || "",
  },
  sweepIntervalMs: num(process.env.SWEEP_INTERVAL_SECONDS, 300) * 1000,
};

/** Defaults applied to a newly registered bin. Every one is per-bin overridable. */
export const BIN_DEFAULTS = Object.freeze({
  empty_distance_mm: 1200,
  full_distance_mm: 150,
  full_threshold_pct: 85,
  clear_threshold_pct: 40,
  consecutive_required: 3,
  repeat_alert_hours: 12,
  offline_after_hours: 24,
  low_battery_v: 3.4,
  high_temp_c: 60,
});
