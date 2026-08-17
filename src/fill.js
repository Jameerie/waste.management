/**
 * Pure fill-level logic. No I/O, no database, no clock - everything is passed
 * in. That keeps this file exhaustively testable, which matters because this
 * is where a bin monitor actually succeeds or fails.
 *
 * The hard problem is not measuring distance. It is deciding that a bin is
 * *genuinely* full. Rubbish shifts, bags fall over, and an ultrasonic pulse
 * that catches the edge of a bag reads "full" for one cycle and "empty" the
 * next. Alert on a raw reading and the admin gets pinged all day, starts
 * ignoring the alerts, and the system is worse than useless.
 *
 * Two mechanisms prevent that:
 *
 *   1. Confirmation - a level must hold above the threshold for N consecutive
 *      readings before it counts.
 *   2. Hysteresis - once FULL, the bin does not return to OK until the level
 *      drops below a much lower threshold. A bin hovering at the full mark
 *      therefore cannot oscillate between states and re-alert each cycle.
 *
 * The gap between clear_threshold_pct and full_threshold_pct is a dead band:
 * readings inside it advance neither counter.
 */

/** Median of a sample, ignoring non-finite values. Returns null if empty. */
export function median(values) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = nums.length >> 1;
  return nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

/**
 * Convert a raw distance reading into a fill percentage.
 *
 * The sensor sits in the lid looking down, so distance is *inversely* related
 * to fill: a large reading means an empty bin.
 *
 * @param {number} distanceMm      measured distance, sensor to rubbish surface
 * @param {number} emptyDistanceMm calibrated reading with the bin empty (large)
 * @param {number} fullDistanceMm  calibrated reading with the bin full (small)
 * @returns {number} 0-100, clamped, to one decimal place
 */
export function levelPct(distanceMm, emptyDistanceMm, fullDistanceMm) {
  const span = emptyDistanceMm - fullDistanceMm;
  if (!(span > 0)) {
    throw new Error(
      `invalid calibration: empty_distance_mm (${emptyDistanceMm}) must be greater than full_distance_mm (${fullDistanceMm})`,
    );
  }
  const pct = ((emptyDistanceMm - distanceMm) / span) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
}

/** A distance the sensor could not plausibly have produced. */
export function isPlausibleDistance(distanceMm, { maxRangeMm = 10000 } = {}) {
  return Number.isFinite(distanceMm) && distanceMm > 0 && distanceMm <= maxRangeMm;
}

export const BIN_STATE = Object.freeze({ OK: "OK", FULL: "FULL" });

export const EVENT = Object.freeze({
  FULL: "FULL",
  STILL_FULL: "STILL_FULL",
  EMPTIED: "EMPTIED",
  OFFLINE: "OFFLINE",
  ONLINE: "ONLINE",
  LOW_BATTERY: "LOW_BATTERY",
  BATTERY_OK: "BATTERY_OK",
  HIGH_TEMP: "HIGH_TEMP",
});

/** Battery must recover by this much before a fresh low-battery alert can fire. */
const BATTERY_RECOVERY_MARGIN_V = 0.15;
/** Temperature must fall this far below the threshold before re-arming. */
const TEMP_RECOVERY_MARGIN_C = 5;

/**
 * Apply one telemetry reading to a bin's state.
 *
 * Pure: returns the changes to persist rather than mutating anything.
 *
 * @param {object} bin     current persisted bin row
 * @param {object} reading { distanceMm, batteryV?, temperatureC? }
 * @param {number} nowMs   current time, injected for testability
 * @returns {{levelPct: number, patch: object, events: Array<{type: string, message: string}>}}
 */
export function applyReading(bin, reading, nowMs) {
  const level = levelPct(reading.distanceMm, bin.empty_distance_mm, bin.full_distance_mm);
  const events = [];
  const patch = { last_seen_at: nowMs, last_level_pct: level };

  // A bin that was offline is, by definition, back.
  if (bin.online === 0) {
    patch.online = 1;
    events.push({
      type: EVENT.ONLINE,
      message: `Bin "${bin.name}" is reporting again (${level}% full).`,
    });
  }

  // --- Confirmation counters --------------------------------------------
  let high = bin.consecutive_high ?? 0;
  let low = bin.consecutive_low ?? 0;

  if (level >= bin.full_threshold_pct) {
    high += 1;
    low = 0;
  } else if (level <= bin.clear_threshold_pct) {
    low += 1;
    high = 0;
  } else {
    // Dead band between the two thresholds - this reading confirms nothing.
    high = 0;
    low = 0;
  }
  patch.consecutive_high = high;
  patch.consecutive_low = low;

  // --- Fill state machine ------------------------------------------------
  const required = bin.consecutive_required;

  if (bin.state === BIN_STATE.OK && high >= required) {
    patch.state = BIN_STATE.FULL;
    patch.state_changed_at = nowMs;
    patch.last_alert_at = nowMs;
    events.push({
      type: EVENT.FULL,
      message: `Bin "${bin.name}" is FULL (${level}%) at ${bin.location || "unknown location"}. Please collect.`,
    });
  } else if (bin.state === BIN_STATE.FULL && low >= required) {
    patch.state = BIN_STATE.OK;
    patch.state_changed_at = nowMs;
    patch.last_alert_at = null;
    events.push({
      type: EVENT.EMPTIED,
      message: `Bin "${bin.name}" has been emptied (now ${level}%).`,
    });
  } else if (bin.state === BIN_STATE.FULL && shouldRemind(bin, nowMs)) {
    // Still full much later - the first alert may have been missed.
    patch.last_alert_at = nowMs;
    events.push({
      type: EVENT.STILL_FULL,
      message: `Reminder: bin "${bin.name}" is still full (${level}%) and has not been collected.`,
    });
  }

  // --- Battery -----------------------------------------------------------
  if (Number.isFinite(reading.batteryV) && Number.isFinite(bin.low_battery_v)) {
    if (reading.batteryV <= bin.low_battery_v && bin.battery_alerted === 0) {
      patch.battery_alerted = 1;
      events.push({
        type: EVENT.LOW_BATTERY,
        message: `Bin "${bin.name}" battery is low (${reading.batteryV.toFixed(2)}V). Recharge or replace the cell.`,
      });
    } else if (
      bin.battery_alerted === 1 &&
      reading.batteryV >= bin.low_battery_v + BATTERY_RECOVERY_MARGIN_V
    ) {
      patch.battery_alerted = 0;
      events.push({
        type: EVENT.BATTERY_OK,
        message: `Bin "${bin.name}" battery recovered (${reading.batteryV.toFixed(2)}V).`,
      });
    }
  }

  // --- Temperature (bin fires are a real hazard) -------------------------
  if (Number.isFinite(reading.temperatureC) && Number.isFinite(bin.high_temp_c)) {
    if (reading.temperatureC >= bin.high_temp_c && bin.temp_alerted === 0) {
      patch.temp_alerted = 1;
      events.push({
        type: EVENT.HIGH_TEMP,
        message: `WARNING: bin "${bin.name}" is at ${reading.temperatureC.toFixed(1)}C - possible fire. Check immediately.`,
      });
    } else if (
      bin.temp_alerted === 1 &&
      reading.temperatureC < bin.high_temp_c - TEMP_RECOVERY_MARGIN_C
    ) {
      patch.temp_alerted = 0;
    }
  }

  return { levelPct: level, patch, events };
}

function shouldRemind(bin, nowMs) {
  if (!bin.repeat_alert_hours || bin.repeat_alert_hours <= 0) return false;
  // Explicit null check: 0 is a legitimate timestamp, and `!0` would skip it.
  if (bin.last_alert_at == null) return false;
  return nowMs - bin.last_alert_at >= bin.repeat_alert_hours * 3600_000;
}

/**
 * Decide whether a bin has gone silent. A sensor that dies quietly is worse
 * than no sensor at all, because everyone assumes the bin is fine.
 *
 * @returns {{patch: object, events: Array}|null} null if nothing changed
 */
export function checkOffline(bin, nowMs) {
  if (bin.online === 0) return null;
  if (!bin.offline_after_hours || bin.offline_after_hours <= 0) return null;

  const since = nowMs - (bin.last_seen_at ?? bin.created_at ?? nowMs);
  if (since < bin.offline_after_hours * 3600_000) return null;

  const hours = Math.floor(since / 3600_000);
  return {
    patch: { online: 0 },
    events: [
      {
        type: EVENT.OFFLINE,
        message: `Bin "${bin.name}" has not reported for ${hours}h. The sensor may be dead, flat, or out of range.`,
      },
    ],
  };
}

/** Manual "I emptied it" from the dashboard, bypassing sensor confirmation. */
export function markCollected(bin, nowMs) {
  return {
    patch: {
      state: BIN_STATE.OK,
      state_changed_at: nowMs,
      last_alert_at: null,
      consecutive_high: 0,
      consecutive_low: 0,
    },
    events: [
      {
        type: EVENT.EMPTIED,
        message: `Bin "${bin.name}" was marked collected by an admin.`,
      },
    ],
  };
}
