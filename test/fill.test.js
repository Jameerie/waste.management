import test from "node:test";
import assert from "node:assert/strict";
import {
  median,
  levelPct,
  applyReading,
  checkOffline,
  markCollected,
  isPlausibleDistance,
  BIN_STATE,
  EVENT,
} from "../src/fill.js";

const HOUR = 3600_000;

/** A calibrated bin: empty reads 1200mm, full reads 200mm. */
function bin(overrides = {}) {
  return {
    id: "bin-1",
    name: "Test Bin",
    location: "Yard",
    empty_distance_mm: 1200,
    full_distance_mm: 200,
    full_threshold_pct: 85,
    clear_threshold_pct: 40,
    consecutive_required: 3,
    repeat_alert_hours: 12,
    offline_after_hours: 24,
    low_battery_v: 3.4,
    high_temp_c: 60,
    state: BIN_STATE.OK,
    state_changed_at: null,
    last_alert_at: null,
    last_seen_at: 0,
    last_level_pct: null,
    consecutive_high: 0,
    consecutive_low: 0,
    online: 1,
    battery_alerted: 0,
    temp_alerted: 0,
    created_at: 0,
    ...overrides,
  };
}

/** Feed a series of distances through the machine, carrying state forward. */
function feed(startBin, distances, startMs = 0, stepMs = HOUR) {
  let current = { ...startBin };
  const events = [];
  distances.forEach((d, i) => {
    const result = applyReading(current, { distanceMm: d }, startMs + i * stepMs);
    current = { ...current, ...result.patch };
    events.push(...result.events);
  });
  return { bin: current, events };
}

test("median ignores non-finite values and handles even counts", () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([1, NaN, 3, undefined]), 2);
  assert.equal(median([]), null);
});

test("levelPct maps calibrated distances to 0-100", () => {
  assert.equal(levelPct(1200, 1200, 200), 0);
  assert.equal(levelPct(200, 1200, 200), 100);
  assert.equal(levelPct(700, 1200, 200), 50);
});

test("levelPct clamps readings outside the calibrated range", () => {
  assert.equal(levelPct(1500, 1200, 200), 0, "beyond empty stays at 0");
  assert.equal(levelPct(50, 1200, 200), 100, "closer than full stays at 100");
});

test("levelPct rejects impossible calibration", () => {
  assert.throws(() => levelPct(500, 200, 1200), /invalid calibration/);
});

test("isPlausibleDistance screens out garbage readings", () => {
  assert.equal(isPlausibleDistance(500), true);
  assert.equal(isPlausibleDistance(0), false);
  assert.equal(isPlausibleDistance(-5), false);
  assert.equal(isPlausibleDistance(99999), false);
  assert.equal(isPlausibleDistance(NaN), false);
});

test("a single high reading does not raise an alert", () => {
  const { bin: after, events } = feed(bin(), [250]);
  assert.equal(events.length, 0);
  assert.equal(after.state, BIN_STATE.OK);
  assert.equal(after.consecutive_high, 1);
});

test("alert fires only after the required consecutive confirmations", () => {
  const { bin: after, events } = feed(bin(), [250, 250, 250]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, EVENT.FULL);
  assert.equal(after.state, BIN_STATE.FULL);
});

test("a transient spike between normal readings never alerts", () => {
  // A bag topples, reads full for one cycle, then settles back.
  const { bin: after, events } = feed(bin(), [900, 250, 900, 250, 900, 250, 900]);
  assert.equal(events.length, 0, "no alert from isolated spikes");
  assert.equal(after.state, BIN_STATE.OK);
});

test("bin does not re-alert on every reading once full", () => {
  const { events } = feed(bin(), [250, 250, 250, 250, 250, 250]);
  const fullAlerts = events.filter((e) => e.type === EVENT.FULL);
  assert.equal(fullAlerts.length, 1, "exactly one FULL alert, not one per reading");
});

test("hysteresis: a bin hovering at the threshold cannot oscillate", () => {
  // Confirm full, then hover just below the full threshold (but above clear).
  // 320mm ~= 88%, 400mm ~= 80% - both inside/near the band, never below 40%.
  const { events } = feed(bin(), [250, 250, 250, 400, 320, 400, 320, 400]);
  const stateChanges = events.filter(
    (e) => e.type === EVENT.FULL || e.type === EVENT.EMPTIED,
  );
  assert.equal(stateChanges.length, 1, "only the initial FULL - no flapping");
});

test("bin clears only after confirmed low readings", () => {
  const start = bin({ state: BIN_STATE.FULL, last_alert_at: 0, consecutive_high: 3 });
  const partial = feed(start, [1000, 1000]);
  assert.equal(partial.bin.state, BIN_STATE.FULL, "two low readings is not yet enough");

  const full = feed(start, [1000, 1000, 1000]);
  assert.equal(full.bin.state, BIN_STATE.OK);
  assert.equal(full.events.at(-1).type, EVENT.EMPTIED);
});

test("readings in the dead band confirm nothing", () => {
  // 700mm = 50%, between clear (40) and full (85).
  const { bin: after } = feed(bin({ consecutive_high: 2 }), [700]);
  assert.equal(after.consecutive_high, 0);
  assert.equal(after.consecutive_low, 0);
});

test("reminder fires when a full bin is left uncollected", () => {
  const start = bin({
    state: BIN_STATE.FULL,
    last_alert_at: 0,
    repeat_alert_hours: 12,
  });

  const early = applyReading(start, { distanceMm: 250 }, 6 * HOUR);
  assert.equal(early.events.length, 0, "no reminder before the interval elapses");

  const late = applyReading(start, { distanceMm: 250 }, 13 * HOUR);
  assert.equal(late.events[0].type, EVENT.STILL_FULL);
  assert.equal(late.patch.last_alert_at, 13 * HOUR);
});

test("reminders can be disabled", () => {
  const start = bin({ state: BIN_STATE.FULL, last_alert_at: 0, repeat_alert_hours: 0 });
  const { events } = applyReading(start, { distanceMm: 250 }, 100 * HOUR);
  assert.equal(events.length, 0);
});

test("low battery alerts once, then re-arms only after real recovery", () => {
  const low = applyReading(bin(), { distanceMm: 900, batteryV: 3.3 }, 0);
  assert.equal(low.events[0].type, EVENT.LOW_BATTERY);
  assert.equal(low.patch.battery_alerted, 1);

  const stillLow = applyReading(
    bin({ battery_alerted: 1 }),
    { distanceMm: 900, batteryV: 3.3 },
    HOUR,
  );
  assert.equal(stillLow.events.length, 0, "does not repeat while still low");

  const marginal = applyReading(
    bin({ battery_alerted: 1 }),
    { distanceMm: 900, batteryV: 3.45 },
    HOUR,
  );
  assert.equal(marginal.events.length, 0, "a tiny rise is not recovery");

  const recovered = applyReading(
    bin({ battery_alerted: 1 }),
    { distanceMm: 900, batteryV: 3.9 },
    HOUR,
  );
  assert.equal(recovered.events[0].type, EVENT.BATTERY_OK);
  assert.equal(recovered.patch.battery_alerted, 0);
});

test("high temperature raises a fire warning once", () => {
  const hot = applyReading(bin(), { distanceMm: 900, temperatureC: 75 }, 0);
  assert.equal(hot.events[0].type, EVENT.HIGH_TEMP);

  const stillHot = applyReading(
    bin({ temp_alerted: 1 }),
    { distanceMm: 900, temperatureC: 75 },
    HOUR,
  );
  assert.equal(stillHot.events.length, 0);
});

test("checkOffline flags a silent bin exactly once", () => {
  const stale = bin({ last_seen_at: 0, offline_after_hours: 24 });

  assert.equal(checkOffline(stale, 12 * HOUR), null, "not yet overdue");

  const result = checkOffline(stale, 30 * HOUR);
  assert.equal(result.events[0].type, EVENT.OFFLINE);
  assert.equal(result.patch.online, 0);

  assert.equal(
    checkOffline({ ...stale, online: 0 }, 40 * HOUR),
    null,
    "already flagged - does not repeat",
  );
});

test("a returning bin reports back online", () => {
  const { events, patch } = applyReading(bin({ online: 0 }), { distanceMm: 900 }, HOUR);
  assert.equal(patch.online, 1);
  assert.equal(events[0].type, EVENT.ONLINE);
});

test("markCollected resets state and counters", () => {
  const { patch, events } = markCollected(
    bin({ state: BIN_STATE.FULL, consecutive_high: 5, last_alert_at: 0 }),
    HOUR,
  );
  assert.equal(patch.state, BIN_STATE.OK);
  assert.equal(patch.consecutive_high, 0);
  assert.equal(patch.last_alert_at, null);
  assert.equal(events[0].type, EVENT.EMPTIED);
});

test("full lifecycle: fills, alerts, is collected, refills, alerts again", () => {
  const distances = [
    1100, 900, 700, // filling
    250, 250, 250,  // confirmed full -> alert
    250,            // still full, no repeat
    1150, 1150, 1150, // collected -> emptied
    800, 300, 250, 250, 250, // refills -> alert again
  ];
  const { events } = feed(bin(), distances);
  const types = events.map((e) => e.type);

  assert.deepEqual(types, [EVENT.FULL, EVENT.EMPTIED, EVENT.FULL]);
});
