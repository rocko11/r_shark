import type { Config, Context } from "@netlify/functions";
import { buildEnvironment } from "../lib/environment.ts";

// GET /api/environment?lat=..&lon=..&region=nyc|nys|nj[&bbl=..][&address=..][&county=..]
// Environmental screen for one property (flood zone, contamination, E-designations, spills).
// Loaded by the report page after the main report renders, so it never slows the report.
export default async (req: Request, _ctx: Context) => {
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), {
    status: s, headers: { "content-type": "application/json", "cache-control": s === 200 ? "public, max-age=3600" : "no-store" } });
  const u = new URL(req.url).searchParams;
  const lat = Number(u.get("lat")), lon = Number(u.get("lon") ?? u.get("lng"));
  const region = (u.get("region") || "nyc").toLowerCase();
  if (!(lat > 38 && lat < 46 && lon > -80.5 && lon < -71)) return json({ error: "lat/lon missing or outside NY/NJ" }, 400);
  if (!["nyc", "nys", "nj"].includes(region)) return json({ error: "region must be nyc, nys or nj" }, 400);
  try {
    const env = await buildEnvironment({
      lat, lon, region: region as any,
      bbl: u.get("bbl") || undefined, address: u.get("address") || undefined, county: u.get("county") || undefined,
    });
    return json(env);
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, 502);
  }
};

export const config: Config = { path: "/api/environment" };
