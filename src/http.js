/** Minimal routing + request helpers over node:http. No framework needed. */

const MAX_BODY_BYTES = 64 * 1024;

export function createRouter() {
  const routes = [];

  const add = (method, pattern, handler) => {
    const names = [];
    const regex = new RegExp(
      "^" +
        pattern
          .split("/")
          .map((seg) => {
            if (!seg.startsWith(":")) return escapeRegex(seg);
            names.push(seg.slice(1));
            return "([^/]+)";
          })
          .join("/") +
        "/?$",
    );
    routes.push({ method, regex, names, handler });
  };

  return {
    get: (p, h) => add("GET", p, h),
    post: (p, h) => add("POST", p, h),
    patch: (p, h) => add("PATCH", p, h),
    delete: (p, h) => add("DELETE", p, h),

    async handle(req, res) {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      for (const route of routes) {
        if (route.method !== req.method) continue;
        const match = route.regex.exec(url.pathname);
        if (!match) continue;

        const params = Object.fromEntries(
          route.names.map((n, i) => [n, decodeURIComponent(match[i + 1])]),
        );
        return route.handler(req, res, { params, query: url.searchParams });
      }

      // Path exists under a different method -> 405 rather than 404.
      const methodMismatch = routes.some((r) => r.regex.test(url.pathname));
      return json(res, methodMismatch ? 405 : 404, {
        error: methodMismatch ? "method not allowed" : "not found",
      });
    },
  };
}

export function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export async function readJson(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error("request body too large");
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }

  if (size === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const err = new Error("body must be valid JSON");
    err.status = 400;
    throw err;
  }
}

/** Extract a bearer token from the Authorization header. */
export function bearer(req) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
