// functions/api/prefetchToday.js — v3.0
// =====================================================================
// CHANGELOG v1 → v3.0:
//   [FIX 1] ลด CACHE_TTL จาก 55 → 20 วินาที
//   [FIX 2] ถ้า URL มี _bust parameter → ข้าม Cloudflare cache
//   [UNCHANGED] ทุกอย่างอื่นเหมือนเดิม
// =====================================================================

import { json } from "./_util.js";

const CACHE_TTL_SECONDS = 20;   // ✅ v3.0: ลดจาก 55 → 20 วินาที
const FETCH_TIMEOUT_MS  = 9000;

export async function onRequestGet({ request, env }) {
  try {
    const url     = new URL(request.url);
    const logDate = (url.searchParams.get("logDate") || "").trim();

    if (!logDate)
      return json({ ok: false, error: "missing_logDate" }, 400);
    if (!env.GAS_URL || !env.SECRET)
      return json({ ok: false, error: "missing_env" }, 500);

    // ✅ v3.0: ถ้ามี _bust → ข้าม cache (index.html ส่งมาหลัง submit สำเร็จ)
    const hasBust = url.searchParams.has("_bust");

    // ── Cloudflare Cache ──
    // ใช้ cache key ที่มีแค่ logDate (ไม่มี _bust) เพื่อให้ทุก request ใช้ cache ร่วมกัน
    const cache    = caches.default;
    const cacheKey = new Request(
      `${url.origin}${url.pathname}?logDate=${encodeURIComponent(logDate)}`,
      { method: "GET" }
    );

    // ถ้าไม่มี _bust → ลองใช้ cache ก่อน
    if (!hasBust) {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    }

    // ── ยิง GAS ──
    const gas = new URL(env.GAS_URL);
    gas.searchParams.set("action",  "getAllStatus");
    gas.searchParams.set("secret",  env.SECRET);
    gas.searchParams.set("logDate", logDate);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let res, out;
    try {
      res = await fetch(gas.toString(), { method: "GET", signal: controller.signal });
      out = await res.json().catch(() => ({}));
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok || out.ok === false) {
      return json({ ok: false, error: out.error || `upstream_${res.status}` }, 500);
    }

    // ── เก็บ cache ใหม่ (ทั้งกรณี _bust และไม่มี) ──
    const response = new Response(JSON.stringify(out), {
      status: 200,
      headers: {
        "Content-Type":  "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`,
        "Access-Control-Allow-Origin": "*",
      },
    });

    cache.put(cacheKey, response.clone());
    return response;

  } catch (e) {
    const msg = e?.name === "AbortError" ? "gas_timeout" : String(e);
    return json({ ok: false, error: msg }, 500);
  }
}
