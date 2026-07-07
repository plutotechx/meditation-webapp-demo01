// functions/api/submit.js — v3.0
// =====================================================================
// CHANGELOG v1 → v3.0:
//   [FIX] เพิ่ม retry 1 ครั้ง เมื่อ GAS timeout (cold start protection)
//   [FIX] เพิ่ม timeout เป็น 28s (จาก 25s) — GAS อาจใช้เวลา 20s+ ตอน cold start
//   [FIX] retry delay 2s ก่อน retry ครั้งที่ 2
//   [FIX] error message ที่ชัดเจนขึ้น สำหรับแต่ละ case
//   [FIX] เพิ่ม x-retry-count header เพื่อ debug
// =====================================================================

import { json } from "./_util.js";

const FETCH_TIMEOUT  = 28000; // 28s — เผื่อ GAS cold start
const RETRY_DELAY_MS = 2000;  // รอ 2 วินาที ก่อน retry
const MAX_RETRIES    = 1;     // retry สูงสุด 1 ครั้ง (รวม = 2 attempts)

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export async function onRequestPost(ctx) {
  const { request, env } = ctx;
  try {
    const body = await request.json().catch(() => ({}));
    const { name, logDate, session, duration, weekday, clientNow, tzOffsetMin } = body || {};

    if (!name || !logDate || !session || !duration) {
      return json({ ok: false, error: "missing_fields" }, 400);
    }

    const GAS_URL = env?.GAS_URL || ctx.cloudflare?.env?.GAS_URL;
    const SECRET  = env?.SECRET  || ctx.cloudflare?.env?.SECRET;
    if (!GAS_URL || !SECRET) {
      return json({ ok: false, error: "missing_env" }, 500);
    }

    // ── Validate timezone ──
    const DRIFT_MINUTES = 10;
    const MS_PER_MIN    = 60 * 1000;

    const off = Number(tzOffsetMin);
    if (!Number.isFinite(off) || Math.abs(off) > 14 * 60) {
      return json({ ok: false, error: "bad_tzOffsetMin" }, 400);
    }

    const m = String(logDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) {
      return json({ ok: false, error: "bad_logDate_format" }, 400);
    }

    const clientMs = Date.parse(String(clientNow || ""));
    if (!Number.isFinite(clientMs)) {
      return json({ ok: false, error: "bad_clientNow" }, 400);
    }

    const serverMs  = Date.now();
    const driftMs   = Math.abs(serverMs - clientMs);
    if (driftMs > DRIFT_MINUTES * MS_PER_MIN) {
      return json({
        ok: false,
        error: "clock_drift_too_large",
        detail: { driftMinutes: Math.round(driftMs / MS_PER_MIN) }
      }, 400);
    }

    const toLocalISODate = (utcMs, tzOff) => {
      const localMs = utcMs - (tzOff * MS_PER_MIN);
      const d = new Date(localMs);
      const y  = d.getUTCFullYear();
      const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
      const da = String(d.getUTCDate()).padStart(2, "0");
      return `${y}-${mo}-${da}`;
    };

    const serverLocalDay = toLocalISODate(serverMs, off);
    if (String(logDate) !== serverLocalDay) {
      return json({
        ok: false,
        error: "logDate_mismatch_server_local_day",
        detail: { expected: serverLocalDay, got: String(logDate) }
      }, 400);
    }

    const clientLocalDay = toLocalISODate(clientMs, off);
    if (String(logDate) !== clientLocalDay) {
      return json({
        ok: false,
        error: "logDate_mismatch_client_local_day",
        detail: { expected: clientLocalDay, got: String(logDate) }
      }, 400);
    }

    // ── Payload to GAS ──
    const payload = {
      secret: SECRET,
      name, logDate,
      weekday: weekday || "",
      session, duration,
      clientNow: clientNow || "",
      tzOffsetMin: off
    };

    // ── Fetch with retry ──
    let res, out;
    let lastError = null;
    let attempts = 0;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      attempts = attempt + 1;

      // รอก่อน retry (ไม่รอตอน attempt แรก)
      if (attempt > 0) {
        await sleep(RETRY_DELAY_MS);
      }

      try {
        res = await fetchWithTimeout(GAS_URL, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(payload),
        }, FETCH_TIMEOUT);

        out = await res.json().catch(() => ({}));

        // ✅ สำเร็จ — break ออกจาก loop
        if (res.ok && out.ok !== false) break;

        // GAS ตอบกลับแต่มี error — ถ้าเป็น server_busy ให้ retry
        if (out.error === "server_busy_retry" && attempt < MAX_RETRIES) {
          lastError = "server_busy_retry";
          continue;
        }

        // GAS ตอบ error อื่น — ไม่ต้อง retry
        break;

      } catch (fetchErr) {
        const isTimeout = fetchErr?.name === "AbortError";
        lastError = isTimeout ? "gas_timeout" : String(fetchErr);

        // ถ้า timeout + ยังเหลือ retry → ลองอีกครั้ง
        if (isTimeout && attempt < MAX_RETRIES) {
          continue;
        }

        // หมด retry แล้ว
        return json({
          ok: false,
          error: lastError,
          attempts,
          hint: isTimeout
            ? "เซิร์ฟเวอร์ตอบช้า กรุณาลองกดบันทึกอีกครั้ง"
            : "เกิดข้อผิดพลาดในการเชื่อมต่อ"
        }, 504);
      }
    }

    // ── Return response ──
    const status = res?.ok ? 200 : 500;
    const headers = {
      "Content-Type":                "application/json; charset=utf-8",
      "Cache-Control":               "no-store",
      "Access-Control-Allow-Origin": "*",
      "X-Attempts":                  String(attempts),
    };

    return new Response(JSON.stringify(out), { status, headers });

  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}
