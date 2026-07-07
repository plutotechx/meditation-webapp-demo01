// functions/api/dashboard.js
import { getEnv, json } from "./_util.js";

const FETCH_TIMEOUT = 25000; // รองรับ GAS cold start

export async function onRequestGet({ request, env }) {
  try {
    const GAS_URL = getEnv({ env }, "GAS_URL");
    const SECRET  = getEnv({ env }, "SECRET");

    const u = new URL(request.url);
    const weekOffset = (u.searchParams.get("weekOffset") || "0").trim();

    const url = new URL(GAS_URL);
    url.searchParams.set("action",     "dashboard");
    url.searchParams.set("secret",     SECRET);
    url.searchParams.set("weekOffset", weekOffset);

    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);

    let res, out;
    try {
      res = await fetch(url.toString(), { method: "GET", signal: ctrl.signal });
      out = await res.json().catch(() => ({}));
    } finally {
      clearTimeout(timer);
    }

    return json(out, res.ok ? 200 : 500);

  } catch (e) {
    const msg = e?.name === "AbortError" ? "gas_timeout" : String(e);
    return json({ ok: false, error: msg }, 500);
  }
}
