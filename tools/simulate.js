/**
 * Drives a running server with realistic fake telemetry, so the whole system -
 * ingest, state machine, alerts, dashboard - can be built and demonstrated
 * before any hardware is bought.
 *
 * Usage:
 *   npm start                       # in one terminal
 *   npm run simulate                # in another
 *
 * Options:
 *   --url=http://localhost:3000     server base URL
 *   --interval=300                  ms between readings (real bins: hourly)
 *   --cycles=3                      fill/collect cycles to run
 *   --spike-chance=0.12             probability of a spurious sensor reading
 */

import { config } from "../src/config.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = "true"] = a.replace(/^--/, "").split("=");
    return [k, v];
  }),
);

const BASE = args.url || `http://localhost:${config.port}`;
const INTERVAL_MS = Number(args.interval ?? 300);
const CYCLES = Number(args.cycles ?? 3);
const SPIKE_CHANCE = Number(args["spike-chance"] ?? 0.12);

const EMPTY_MM = 1200;
const FULL_MM = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

async function main() {
  if (!config.adminToken || config.adminToken === "change-me") {
    console.error("ADMIN_TOKEN is not set. Copy .env.example to .env and set one.");
    process.exit(1);
  }

  await api("GET", "/api/v1/health").catch(() => {
    console.error(`No server at ${BASE}. Start it with: npm start`);
    process.exit(1);
  });

  const created = await api("POST", "/api/v1/bins", {
    token: config.adminToken,
    body: {
      name: `Simulated Bin ${new Date().toISOString().slice(11, 19)}`,
      location: "Simulator",
      empty_distance_mm: EMPTY_MM,
      full_distance_mm: FULL_MM,
    },
  });

  const binId = created.bin.id;
  const deviceToken = created.device_token;
  console.log(`Simulating bin ${binId} against ${BASE}`);
  console.log(`Watch alerts in the server terminal, or open ${BASE}\n`);

  let batteryV = 4.15;

  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    console.log(`--- cycle ${cycle}/${CYCLES} -------------------------------`);

    // Rubbish accumulates: distance shrinks from empty toward full.
    let trueDistance = EMPTY_MM;

    const post = async (distanceMm, spiked = false) => {
      batteryV = Math.max(3.2, batteryV - 0.004 - Math.random() * 0.004);

      const result = await api("POST", `/api/v1/bins/${binId}/telemetry`, {
        token: deviceToken,
        body: {
          distance_mm: Math.round(distanceMm),
          battery_v: Number(batteryV.toFixed(2)),
          temperature_c: Number((22 + Math.random() * 6).toFixed(1)),
          rssi: -50 - Math.round(Math.random() * 35),
        },
      });

      const flags = [
        spiked ? "SPIKE" : null,
        result.events.length ? `-> ${result.events.join(",")}` : null,
      ]
        .filter(Boolean)
        .join(" ");

      console.log(
        `  ${String(Math.round(distanceMm)).padStart(5)}mm  ` +
          `${String(result.level_pct).padStart(5)}%  ${result.state.padEnd(5)} ${flags}`,
      );

      await sleep(INTERVAL_MS);
      return result;
    };

    // 1. Filling up.
    while (trueDistance > FULL_MM + 20) {
      trueDistance = Math.max(trueDistance - (40 + Math.random() * 110), FULL_MM - 10);

      // Real sensors occasionally return nonsense: a bag flops across the
      // beam, or the pulse catches a bin wall. The confirmation logic in
      // fill.js exists precisely so these do not trigger alerts - watch the
      // SPIKE lines pass without raising anything.
      const spiked = Math.random() < SPIKE_CHANCE;
      const reported = spiked
        ? FULL_MM - 40 + Math.random() * 30
        : trueDistance + (Math.random() * 24 - 12); // ordinary measurement noise

      await post(reported, spiked);
    }

    // 2. Genuinely full, and it stays that way. This is what separates a real
    //    fill from a spike: the level holds until confirmation is reached.
    let result = { state: "OK" };
    for (let i = 0; i < 8 && result.state !== "FULL"; i++) {
      result = await post(trueDistance + (Math.random() * 20 - 10));
    }

    // 3. A collector empties it. Confirmed low readings clear the alert.
    console.log("  ...collected");
    for (let i = 0; i < 8 && result.state !== "OK"; i++) {
      result = await post(EMPTY_MM - Math.random() * 40);
    }
  }

  console.log(`\nDone. Review the event log: ${BASE}/api/v1/events`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
