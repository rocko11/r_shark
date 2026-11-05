import type { Config } from "@netlify/functions";
import { gate } from "../lib/access.ts";
import { redactResponse } from "../lib/redact.ts";
import { buildEasements } from "../lib/easements.ts";

// GET /api/easements?bbl=3011410128 — every recorded easement / encumbrance on the lot, in detail.
// Loaded by the report page after the main report renders.
const __inner = async (req: Request) => {
  const bbl = (new URL(req.url).searchParams.get("bbl") || "").replace(/\D/g, "");
  if (bbl.length !== 10) return Response.json({ error: "bbl (10 digits) required" }, { status: 400 });
  try {
    const r: any = await buildEasements(bbl);
    const partial = Object.keys(r.sources_failed || {}).length > 0;
    return new Response(JSON.stringify(r), { headers: { "content-type": "application/json", "cache-control": partial ? "no-store" : "private, max-age=3600" } });
  } catch (e: any) {
    return Response.json({ error: "Easement records are unavailable right now. " + String(e?.message || e).slice(0, 120) }, { status: 502, headers: { "cache-control": "no-store" } });
  }
};

export default async (req: Request) => {
  const ent = await gate(req, "basic", { preview: true }); if (ent instanceof Response) return ent;
  const res = await __inner(req);
  return ent.teaser ? redactResponse(res) : res;
};
export const config: Config = { path: "/api/easements" };
