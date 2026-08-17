import { applyReading, checkOffline, markCollected, isPlausibleDistance } from "./fill.js";
import * as store from "./db.js";
import { sendAlert } from "./notifier.js";

/**
 * Glue between the pure logic in fill.js and the outside world: persist the
 * reading, persist any events it produced, then push notifications.
 */

export class IngestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Record one telemetry reading and fire any resulting alerts.
 *
 * @param {object} deps      { db, notify } - notify is injectable for tests
 * @param {object} bin       the authenticated bin row
 * @param {object} reading   { distanceMm, batteryV?, temperatureC?, rssi? }
 * @param {number} nowMs
 */
export async function ingestReading({ db, notify = sendAlert }, bin, reading, nowMs = Date.now()) {
  if (!isPlausibleDistance(reading.distanceMm)) {
    throw new IngestError(
      `distance_mm must be a positive number below 10000 (got ${reading.distanceMm})`,
    );
  }

  const { levelPct, patch, events } = applyReading(bin, reading, nowMs);

  store.insertReading(db, bin.id, reading, levelPct, nowMs);
  store.patchBinState(db, bin.id, patch);
  await dispatch({ db, notify }, bin.id, events, levelPct, nowMs);

  return { levelPct, state: patch.state ?? bin.state, events };
}

/**
 * Find bins that have gone silent. Runs on a timer rather than on ingest,
 * because the whole point is detecting the absence of readings.
 */
export async function sweepOffline({ db, notify = sendAlert }, nowMs = Date.now()) {
  const fired = [];
  for (const bin of store.listBins(db)) {
    const result = checkOffline(bin, nowMs);
    if (!result) continue;
    store.patchBinState(db, bin.id, result.patch);
    await dispatch({ db, notify }, bin.id, result.events, bin.last_level_pct, nowMs);
    fired.push(bin.id);
  }
  return fired;
}

/** Admin pressed "mark collected" in the dashboard. */
export async function collectBin({ db, notify = sendAlert }, bin, nowMs = Date.now()) {
  const { patch, events } = markCollected(bin, nowMs);
  store.patchBinState(db, bin.id, patch);
  await dispatch({ db, notify }, bin.id, events, bin.last_level_pct, nowMs);
  return store.getBin(db, bin.id);
}

async function dispatch({ db, notify }, binId, events, levelPct, nowMs) {
  for (const event of events) {
    const eventId = store.insertEvent(db, binId, event, levelPct, nowMs);
    const delivered = await notify(event.message);
    if (delivered) store.markEventNotified(db, eventId);
  }
}
