import test from "node:test";
import assert from "node:assert/strict";

// Must be set before the module graph loads - config.js reads env at import.
process.env.ADMIN_TOKEN = "test-admin-token";
process.env.TELEGRAM_BOT_TOKEN = "";
process.env.TELEGRAM_CHAT_ID = "";

const { openDb } = await import("../src/db.js");
const { createServer } = await import("../src/server.js");

const ADMIN = "test-admin-token";

/** Boot a server on an ephemeral port with an in-memory DB and captured alerts. */
async function harness() {
  const alerts = [];
  const db = openDb(":memory:");
  const { server } = createServer({
    db,
    notify: async (message) => {
      alerts.push(message);
      return true;
    },
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  return {
    call,
    alerts,
    async close() {
      await new Promise((r) => server.close(r));
      db.close();
    },
  };
}

/** Register a bin calibrated so 1200mm reads empty and 200mm reads full. */
async function makeBin(call, overrides = {}) {
  const res = await call("POST", "/api/v1/bins", {
    token: ADMIN,
    body: {
      name: "Yard Bin",
      location: "Loading bay",
      empty_distance_mm: 1200,
      full_distance_mm: 200,
      ...overrides,
    },
  });
  assert.equal(res.status, 201);
  return { id: res.body.bin.id, token: res.body.device_token };
}

test("health is public and reports alert configuration", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const res = await h.call("GET", "/api/v1/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.alerts_configured, false);
});

test("admin routes reject missing and wrong tokens", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  assert.equal((await h.call("GET", "/api/v1/bins")).status, 401);
  assert.equal((await h.call("GET", "/api/v1/bins", { token: "nope" })).status, 401);
  assert.equal((await h.call("GET", "/api/v1/bins", { token: ADMIN })).status, 200);
});

test("creating a bin returns a device token exactly once", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const { id, token } = await makeBin(h.call);
  assert.ok(token && token.length > 20);

  const fetched = await h.call("GET", `/api/v1/bins/${id}`, { token: ADMIN });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.bin.token_hash, undefined, "hash must never be exposed");
  assert.equal(fetched.body.bin.device_token, undefined);
});

test("bin creation rejects impossible calibration and thresholds", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const badCal = await h.call("POST", "/api/v1/bins", {
    token: ADMIN,
    body: { name: "Bad", empty_distance_mm: 100, full_distance_mm: 900 },
  });
  assert.equal(badCal.status, 400);

  const badThresh = await h.call("POST", "/api/v1/bins", {
    token: ADMIN,
    body: { name: "Bad", full_threshold_pct: 30, clear_threshold_pct: 80 },
  });
  assert.equal(badThresh.status, 400);
});

test("telemetry requires the correct per-bin device token", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const { id } = await makeBin(h.call);
  const body = { distance_mm: 900 };

  assert.equal((await h.call("POST", `/api/v1/bins/${id}/telemetry`, { body })).status, 401);
  assert.equal(
    (await h.call("POST", `/api/v1/bins/${id}/telemetry`, { token: "wrong", body })).status,
    401,
  );
});

test("one bin's token cannot post to another bin", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const a = await makeBin(h.call, { name: "A" });
  const b = await makeBin(h.call, { name: "B" });

  const res = await h.call("POST", `/api/v1/bins/${b.id}/telemetry`, {
    token: a.token,
    body: { distance_mm: 900 },
  });
  assert.equal(res.status, 401);
});

test("unknown bin id returns 401, not 404, so ids cannot be enumerated", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const res = await h.call("POST", "/api/v1/bins/does-not-exist/telemetry", {
    token: "anything",
    body: { distance_mm: 900 },
  });
  assert.equal(res.status, 401);
});

test("implausible distances are rejected", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const { id, token } = await makeBin(h.call);
  for (const distance_mm of [0, -10, 50000, "banana"]) {
    const res = await h.call(`POST`, `/api/v1/bins/${id}/telemetry`, {
      token,
      body: { distance_mm },
    });
    assert.equal(res.status, 400, `expected rejection for ${distance_mm}`);
  }
});

test("telemetry drives the fill state machine and alerts once", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const { id, token } = await makeBin(h.call);
  const post = (distance_mm) =>
    h.call("POST", `/api/v1/bins/${id}/telemetry`, { token, body: { distance_mm } });

  const first = await post(250);
  assert.equal(first.status, 202);
  assert.equal(first.body.level_pct, 95);
  assert.equal(first.body.state, "OK", "one reading is not enough");
  assert.equal(h.alerts.length, 0);

  await post(250);
  const third = await post(250);
  assert.equal(third.body.state, "FULL");
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0], /FULL/);

  // Further full readings must not produce more alerts.
  await post(250);
  await post(250);
  assert.equal(h.alerts.length, 1, "no alert spam while it stays full");
});

test("admin can mark a bin collected, which resets state", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const { id, token } = await makeBin(h.call);
  for (let i = 0; i < 3; i++) {
    await h.call("POST", `/api/v1/bins/${id}/telemetry`, { token, body: { distance_mm: 250 } });
  }

  const res = await h.call("POST", `/api/v1/bins/${id}/collected`, { token: ADMIN });
  assert.equal(res.status, 200);
  assert.equal(res.body.bin.state, "OK");
  assert.match(h.alerts.at(-1), /marked collected/);
});

test("events are recorded and listable", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const { id, token } = await makeBin(h.call);
  for (let i = 0; i < 3; i++) {
    await h.call("POST", `/api/v1/bins/${id}/telemetry`, { token, body: { distance_mm: 250 } });
  }

  const res = await h.call("GET", "/api/v1/events", { token: ADMIN });
  assert.equal(res.status, 200);
  assert.equal(res.body.events[0].type, "FULL");
  assert.equal(res.body.events[0].notified, 1);
});

test("readings are stored and returned newest first", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const { id, token } = await makeBin(h.call);
  for (const d of [1100, 800, 400]) {
    await h.call("POST", `/api/v1/bins/${id}/telemetry`, { token, body: { distance_mm: d } });
  }

  const res = await h.call("GET", `/api/v1/bins/${id}`, { token: ADMIN });
  assert.equal(res.body.readings.length, 3);
  assert.equal(res.body.readings[0].distance_mm, 400);
});

test("recalibration changes how the same distance is interpreted", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const { id, token } = await makeBin(h.call);

  const before = await h.call("POST", `/api/v1/bins/${id}/telemetry`, {
    token,
    body: { distance_mm: 700 },
  });
  assert.equal(before.body.level_pct, 50);

  await h.call("PATCH", `/api/v1/bins/${id}`, {
    token: ADMIN,
    body: { empty_distance_mm: 900, full_distance_mm: 500 },
  });

  const after = await h.call("POST", `/api/v1/bins/${id}/telemetry`, {
    token,
    body: { distance_mm: 700 },
  });
  assert.equal(after.body.level_pct, 50);

  const shallow = await h.call("POST", `/api/v1/bins/${id}/telemetry`, {
    token,
    body: { distance_mm: 600 },
  });
  assert.equal(shallow.body.level_pct, 75);
});

test("routing returns 404 for unknown paths and 405 for wrong methods", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  assert.equal((await h.call("GET", "/api/v1/nope")).status, 404);
  assert.equal((await h.call("DELETE", "/api/v1/health")).status, 405);
});

test("deleting a bin removes it", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const { id } = await makeBin(h.call);
  assert.equal((await h.call("DELETE", `/api/v1/bins/${id}`, { token: ADMIN })).status, 200);
  assert.equal((await h.call("GET", `/api/v1/bins/${id}`, { token: ADMIN })).status, 404);
});
