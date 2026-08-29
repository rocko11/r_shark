import type { Config, Context } from "@netlify/functions";
import { skipTraceOwner } from "../lib/skiptrace.ts";

// POST /api/skiptrace  { address, city?, state?, zip? }
// On-demand owner skip-trace (paid, per-match via DataSkip). Fired only when the
// user explicitly asks - never automatically from /api/report. If SKIPTRACE_API_KEY
// isn't set, the endpoint reports the feature is off rather than erroring.
export default async (req: Request, _ctx: Context) => {
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { /* allow query fallback */ }
  const u = new URL(req.url).searchParams;
  const address = body.address || u.get("address") || "";
  const city = body.city || u.get("city") || "";
  const state = body.state || u.get("state") || "NY";
  const zip = body.zip || u.get("zip") || "";

  if (!address) return json({ error: "address required" }, 400);

  const result = await skipTraceOwner({ address, city, state, zip });
  return json(result);
};

export const config: Config = { path: "/api/skiptrace" };
