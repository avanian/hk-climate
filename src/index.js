// Cloudflare Worker: serves the static front-end and a cached JSON API,
// and refreshes the dataset on a daily Cron Trigger.

import { buildDataset } from "./hko.js";

const KEY = "dataset:v1";

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refresh(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/temps") {
      return serveDataset(env);
    }

    // Populate or refresh KV without waiting for the cron. Allowed from
    // localhost during development, or from anywhere with the REFRESH_TOKEN
    // secret set (e.g. the deploy workflow warming the cache).
    if (url.pathname === "/api/refresh") {
      if (!isLocal(url.hostname) && !isAuthorized(request, env)) {
        return new Response("forbidden", { status: 403 });
      }
      const data = await refresh(env);
      return Response.json({ ok: true, meta: data.meta });
    }

    return env.ASSETS.fetch(request);
  },
};

async function refresh(env) {
  const data = await buildDataset();
  await env.TEMPS.put(KEY, JSON.stringify(data));
  return data;
}

async function serveDataset(env) {
  const body = await env.TEMPS.get(KEY, "text");
  if (body == null) {
    return new Response(
      JSON.stringify({
        error:
          "dataset not built yet; wait for the daily cron or POST /api/refresh with a token",
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=1800",
      "access-control-allow-origin": "*",
    },
  });
}

function isLocal(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isAuthorized(request, env) {
  const expected = env.REFRESH_TOKEN;
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const provided = header.replace(/^Bearer\s+/i, "");
  if (provided.length !== expected.length) return false;
  const encoder = new TextEncoder();
  return crypto.subtle.timingSafeEqual(
    encoder.encode(provided),
    encoder.encode(expected),
  );
}
