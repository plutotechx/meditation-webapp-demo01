import { getEnv, json } from "./_util.js";

// snapshotWeek ไม่มีใน GAS — redirect ไปใช้ dashboard แทน
export async function onRequestGet(ctx) {
  try {
    const GAS_URL = getEnv(ctx, "GAS_URL");
    const SECRET  = getEnv(ctx, "SECRET");

    const url = new URL(GAS_URL);
    url.searchParams.set("action",     "dashboard");
    url.searchParams.set("secret",     SECRET);
    url.searchParams.set("weekOffset", "0");

    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    let res, out;
    try {
      res = await fetch(url.toString(), { method: "GET", signal: ctrl.signal });
      out = await res.json().catch(() => ({}));
    } catch (fetchErr) {
      const isTimeout = fetchErr?.name === "AbortError";
      return json({ ok: false, error: isTimeout ? "gas_timeout" : String(fetchErr) }, 500);
    } finally {
      clearTimeout(timer);
    }

    return json(out, res.ok ? 200 : 500);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}
