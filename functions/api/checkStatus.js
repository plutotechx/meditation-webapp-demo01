import { json } from "./_util.js";

const CACHE_TTL     = 45;
const FETCH_TIMEOUT = 25000; // เพิ่มจาก 8000 → 25000ms รองรับ GAS cold start
const RETRY_DELAY   = 1500;  // รอ 1.5 วิ แล้ว retry 1 ครั้ง

async function fetchWithTimeout(url, timeoutMs) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequestGet(ctx) {
  const { request, env } = ctx;
  try {
    const url     = new URL(request.url);
    const name    = (url.searchParams.get("name")    || "").trim();
    const logDate = (url.searchParams.get("logDate") || "").trim();

    if (!name || !logDate) {
      return json({ ok: false, error: "missing_fields" }, 400);
    }

    const GAS_URL = env?.GAS_URL || ctx.cloudflare?.env?.GAS_URL;
    const SECRET  = env?.SECRET  || ctx.cloudflare?.env?.SECRET;
    if (!GAS_URL || !SECRET) {
      return json({ ok: false, error: "missing_env" }, 500);
    }

    // ── Cloudflare Cache ──
    const cache    = caches.default;
    const cacheKey = new Request(
      `https://cache.internal/checkStatus?name=${encodeURIComponent(name)}&logDate=${encodeURIComponent(logDate)}`
    );
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    // ── Build GAS URL ──
    const gas = new URL(GAS_URL);
    gas.searchParams.set("action",  "checkStatus");
    gas.searchParams.set("secret",  SECRET);
    gas.searchParams.set("name",    name);
    gas.searchParams.set("logDate", logDate);
    const gasUrl = gas.toString();

    // ── Fetch พร้อม retry 1 ครั้ง ──
    let res, out;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) await new Promise(r => setTimeout(r, RETRY_DELAY));
        res = await fetchWithTimeout(gasUrl, FETCH_TIMEOUT);
        out = await res.json().catch(() => ({}));
        if (res.ok && out.ok !== false) break;
      } catch (fetchErr) {
        if (attempt === 1) {
          const isTimeout = fetchErr?.name === "AbortError";
          return json({ ok: false, error: isTimeout ? "gas_timeout" : String(fetchErr) }, 500);
        }
      }
    }

    // ── Cache response ที่สำเร็จ ──
    const response = new Response(JSON.stringify(out), {
      status: res.ok ? 200 : 500,
      headers: {
        "Content-Type":                "application/json; charset=utf-8",
        "Cache-Control":               `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}`,
        "Access-Control-Allow-Origin": "*",
      },
    });

    if (res.ok && out.ok !== false) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;

  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}
