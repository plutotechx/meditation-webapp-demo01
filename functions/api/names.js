import { getEnv, withAction, json } from "./_util.js";

const FETCH_TIMEOUT_MS = 7000;
const CACHE_TTL_SECONDS = 600;

export async function onRequestGet(context) {
  const { request } = context;

  try {
    const GAS_URL = getEnv(context, "GAS_URL");
    const SECRET = getEnv(context, "SECRET");

    const cache = caches.default;
    const cacheKey = new Request(new URL(request.url).toString(), { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const url = withAction(GAS_URL, "names", SECRET);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let res, out;
    try {
      res = await fetch(url, { method: "GET", signal: controller.signal });
      out = await res.json().catch(() => ({}));
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok || out.ok === false) {
      return json({ ok: false, error: out.error || `upstream_${res.status}` }, 500);
    }

    const response = new Response(JSON.stringify(out), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`,
      },
    });

    context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;

  } catch (e) {
    const msg = e?.name === "AbortError" ? "gas_timeout" : String(e);
    return json({ ok: false, error: msg }, 500);
  }
}
