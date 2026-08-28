import type { Config, Context } from "@netlify/functions";
import * as sq from "../lib/socrata.ts";

// GET /api/nearby?lat=..&lng=..&radius=250   (radius in meters, default ~2 blocks)
// Returns lightweight lot pins around a point: bbl, address, lat/lng, and a few
// headline fields so the map can label them and colour them by signal. Clicking
// a pin then calls /api/report?bbl=... for the full picture.
export default async (req: Request, _ctx: Context) => {
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  try {
    const u = new URL(req.url).searchParams;
    const lat = Number(u.get("lat")), lng = Number(u.get("lng"));
    const radius = Math.min(Number(u.get("radius")) || 250, 800); // cap so we don't pull half a borough
    const self = u.get("bbl") || "";
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ error: "lat and lng required" }, 400);

    // within_circle(location, lat, lng, meters) — note within_circle uses the
    // conventional lat,lng ordering (unlike WKT). PLUTO exposes latitude/longitude
    // and a derived point column; we select the scalar lat/lng to stay simple.
    const where = `within_circle(location, ${lat}, ${lng}, ${radius})`;
    let rows: any[];
    try {
      rows = await sq.query("pluto", {
        where,
        select: "bbl,address,latitude,longitude,unitsres,bldgclass,builtfar,residfar,lotarea,yearbuilt,ownername,histdist,landmark",
        limit: 400,
      });
    } catch {
      // Some PLUTO releases name the point column differently; fall back to a
      // bounding box on the scalar lat/lng columns, which always exist.
      const d = radius / 111000; // rough degrees per meter
      const bbox = `latitude between ${lat - d} and ${lat + d} AND longitude between ${lng - d / Math.cos(lat * Math.PI / 180)} and ${lng + d / Math.cos(lat * Math.PI / 180)}`;
      rows = await sq.query("pluto", {
        where: bbox,
        select: "bbl,address,latitude,longitude,unitsres,bldgclass,builtfar,residfar,lotarea,yearbuilt,ownername,histdist,landmark",
        limit: 400,
      });
    }

    const num = (v: any) => (v === null || v === undefined || v === "" ? null : Number(v));
    const lots = rows
      .map((r) => {
        const la = num(r.latitude), ln = num(r.longitude);
        if (la === null || ln === null) return null;
        const built = num(r.builtfar), resid = num(r.residfar);
        // A cheap "worth a look" signal for pin colour: under-built vs. residential
        // FAR (room to develop), landmark/historic (constrained), or pre-1974 multi-
        // family (likely rent-stabilised). Full truth still comes from /api/report.
        let signal: "opportunity" | "constrained" | "neutral" = "neutral";
        if (r.landmark?.trim() || r.histdist?.trim()) signal = "constrained";
        else if (resid && built !== null && built < resid * 0.6) signal = "opportunity";
        return {
          bbl: r.bbl, address: r.address || r.bbl, lat: la, lng: ln,
          units_res: num(r.unitsres), bldg_class: r.bldgclass,
          built_far: built, resid_far: resid, lot_area: num(r.lotarea),
          year_built: num(r.yearbuilt), owner: r.ownername,
          is_self: r.bbl === self, signal,
        };
      })
      .filter(Boolean);

    return json({ center: { lat, lng }, radius, count: lots.length, lots });
  } catch (e) {
    return json({ error: `${(e as Error).name}: ${(e as Error).message}`.slice(0, 300) }, 500);
  }
};

export const config: Config = { path: "/api/nearby" };
