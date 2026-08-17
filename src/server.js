import http from "node:http";
import { openDb } from "./db.js";
import { config } from "./config.js";
import { buildRoutes } from "./routes.js";
import { sweepOffline } from "./alerts.js";
import { isConfigured } from "./notifier.js";

export function createServer({ db, notify } = {}) {
  const database = db ?? openDb();
  const router = buildRoutes({ db: database, notify });

  const server = http.createServer((req, res) => {
    router.handle(req, res).catch((err) => {
      console.error("[http] unhandled", err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal server error" }));
      }
    });
  });

  return { server, db: database };
}

// Only start listening when run directly, so tests can import cleanly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { server, db } = createServer();

  server.listen(config.port, () => {
    console.log(`waste-management listening on http://localhost:${config.port}`);
    console.log(`  database : ${config.dbPath}`);
    console.log(
      `  alerts   : ${isConfigured() ? "telegram" : "console only (set TELEGRAM_* in .env)"}`,
    );
    if (!config.adminToken || config.adminToken === "change-me") {
      console.warn("  WARNING  : ADMIN_TOKEN is unset - admin routes are disabled.");
    }
  });

  // Detect bins that have gone silent.
  const sweep = setInterval(() => {
    sweepOffline({ db }).catch((err) => console.error("[sweep]", err));
  }, config.sweepIntervalMs);
  sweep.unref();

  const shutdown = () => {
    console.log("\nshutting down");
    clearInterval(sweep);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
