import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRouter, json, readJson, bearer } from "./http.js";
import * as store from "./db.js";
import { config, ROOT, BIN_DEFAULTS } from "./config.js";
import { ingestReading, collectBin, IngestError } from "./alerts.js";
import { isConfigured } from "./notifier.js";

export function buildRoutes({ db, notify }) {
  const router = createRouter();
  const deps = { db, notify };

  // --- Auth ---------------------------------------------------------------

  /** Admin auth. Returns null when authorised, or a response-sending function. */
  function requireAdmin(req, res) {
    if (!config.adminToken || config.adminToken === "change-me") {
      json(res, 503, {
        error: "ADMIN_TOKEN is not configured. Set it in .env before using admin routes.",
      });
      return false;
    }
    const token = bearer(req) || req.headers["x-admin-token"];
    if (!token || !store.safeEqual(token, config.adminToken)) {
      json(res, 401, { error: "unauthorized" });
      return false;
    }
    return true;
  }

  /** Device auth: the bearer token must match this specific bin's token. */
  function authenticateBin(req, res, binId) {
    const bin = store.getBin(db, binId);
    const token = bearer(req);

    // Same response whether the bin is missing or the token is wrong, so the
    // endpoint cannot be used to enumerate which bin ids exist.
    if (!bin || !token || !store.safeEqual(store.hashToken(token), bin.token_hash)) {
      json(res, 401, { error: "unauthorized" });
      return null;
    }
    return bin;
  }

  // --- Public -------------------------------------------------------------

  router.get("/api/v1/health", (req, res) =>
    json(res, 200, {
      ok: true,
      bins: store.listBins(db).length,
      alerts_configured: isConfigured(),
      time: new Date().toISOString(),
    }),
  );

  // --- Device ingest ------------------------------------------------------

  router.post("/api/v1/bins/:id/telemetry", async (req, res, { params }) => {
    const bin = authenticateBin(req, res, params.id);
    if (!bin) return;

    try {
      const body = await readJson(req);
      const reading = {
        distanceMm: Number(body.distance_mm),
        batteryV: body.battery_v == null ? undefined : Number(body.battery_v),
        temperatureC: body.temperature_c == null ? undefined : Number(body.temperature_c),
        rssi: body.rssi == null ? undefined : Number(body.rssi),
      };

      const result = await ingestReading(deps, bin, reading);

      return json(res, 202, {
        ok: true,
        level_pct: result.levelPct,
        state: result.state,
        events: result.events.map((e) => e.type),
      });
    } catch (err) {
      const status = err instanceof IngestError ? err.status : (err.status ?? 500);
      if (status >= 500) console.error("[ingest]", err);
      return json(res, status, { error: err.message });
    }
  });

  // --- Admin: bins --------------------------------------------------------

  router.get("/api/v1/bins", (req, res) => {
    if (!requireAdmin(req, res)) return;
    json(res, 200, { bins: store.listBins(db).map(publicBin) });
  });

  router.post("/api/v1/bins", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const body = await readJson(req);
      if (!body.name) return json(res, 400, { error: "name is required" });

      const { bin, token } = store.createBin(db, body);
      // The only time the device token is ever visible.
      return json(res, 201, {
        bin: publicBin(bin),
        device_token: token,
        note: "Store this token in the device firmware now - it cannot be retrieved again.",
      });
    } catch (err) {
      const status = err instanceof store.ValidationError ? 400 : (err.status ?? 500);
      if (status >= 500) console.error("[create bin]", err);
      return json(res, status, { error: err.message });
    }
  });

  router.get("/api/v1/bins/:id", (req, res, { params, query }) => {
    if (!requireAdmin(req, res)) return;
    const bin = store.getBin(db, params.id);
    if (!bin) return json(res, 404, { error: "bin not found" });

    const limit = Math.min(Number(query.get("limit")) || 100, 1000);
    json(res, 200, {
      bin: publicBin(bin),
      readings: store.recentReadings(db, bin.id, limit),
    });
  });

  router.patch("/api/v1/bins/:id", async (req, res, { params }) => {
    if (!requireAdmin(req, res)) return;
    if (!store.getBin(db, params.id)) return json(res, 404, { error: "bin not found" });

    try {
      const updated = store.updateBin(db, params.id, await readJson(req));
      return json(res, 200, { bin: publicBin(updated) });
    } catch (err) {
      const status = err instanceof store.ValidationError ? 400 : (err.status ?? 500);
      if (status >= 500) console.error("[update bin]", err);
      return json(res, status, { error: err.message });
    }
  });

  router.delete("/api/v1/bins/:id", (req, res, { params }) => {
    if (!requireAdmin(req, res)) return;
    if (!store.getBin(db, params.id)) return json(res, 404, { error: "bin not found" });
    store.deleteBin(db, params.id);
    json(res, 200, { ok: true });
  });

  router.post("/api/v1/bins/:id/collected", async (req, res, { params }) => {
    if (!requireAdmin(req, res)) return;
    const bin = store.getBin(db, params.id);
    if (!bin) return json(res, 404, { error: "bin not found" });
    json(res, 200, { bin: publicBin(await collectBin(deps, bin)) });
  });

  // --- Admin: events ------------------------------------------------------

  router.get("/api/v1/events", (req, res, { query }) => {
    if (!requireAdmin(req, res)) return;
    const limit = Math.min(Number(query.get("limit")) || 50, 500);
    json(res, 200, { events: store.recentEvents(db, limit) });
  });

  router.get("/api/v1/defaults", (req, res) => {
    if (!requireAdmin(req, res)) return;
    json(res, 200, { defaults: BIN_DEFAULTS });
  });

  // --- Dashboard ----------------------------------------------------------

  router.get("/", async (req, res) => {
    try {
      const html = await readFile(path.join(ROOT, "public", "index.html"));
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": html.length,
      });
      res.end(html);
    } catch {
      json(res, 404, { error: "dashboard not found" });
    }
  });

  return router;
}

/** Never expose token_hash over the API. */
function publicBin(bin) {
  const { token_hash, ...rest } = bin;
  return rest;
}
