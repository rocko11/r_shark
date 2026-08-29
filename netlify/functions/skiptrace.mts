import type { Config, Context } from "@netlify/functions";
import { skipTraceOwner } from "../lib/skiptrace.ts";

// POST /api/skiptrace  { address, city?, state?, zip?, gate? }
// On-demand owner skip-trace (paid, per-match via DataSkip). Fired only when the
// user explicitly asks - never automatically from /api/report.
//
// COST PROTECTION: every successful call spends real money, so this endpoint is
// gated behind a passphrase. If SKIPTRACE_GATE is set, the caller must send a
// matching gate value or the request is rejected BEFORE any paid DataSkip call.
// The passphrase lives only in Netlify env vars and the user's head - never in the
// public frontend - so finding the endpoint or loading the page can't drain the
// balance. If SKIPTRACE_GATE is unset, the endpoint still works but is unprotected.
export default async (req: Request, _ctx: Context) => {
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { /* allow query fallback */ }
  const u = new URL(req.url).searchParams;

  // Passphrase gate - checked before anything paid happens.
  const gateExpected = process.env.SKIPTRACE_GATE;
  if (gateExpected) {
    const gateGiven = body.gate || u.get("gate") || "";
    if (gateGiven !== gateExpected) {
      return json({ error: "unauthorized", gated: true }, 401);
    }
  }

  const address = body.address || u.get("address") || "";
  const city = body.city || u.get("city") || "";
  const state = body.state || u.get("state") || "NY";
  const zip = body.zip || u.get("zip") || "";

  if (!address) return json({ error: "address required" }, 400);

  const result = await skipTraceOwner({ address, city, state, zip });
  return json(result);
};

export const config: Config = { path: "/api/skiptrace" };
