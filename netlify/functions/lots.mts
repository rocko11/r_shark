import type { Config, Context } from "@netlify/functions";

// GET /api/lots?bbl=1010740014                  -> just the property's own block
// GET /api/lots?bbl=..&lat=..&lng=..&blocks=5   -> all lots within ~N blocks of the property
//
// Returns tax-lot polygons + PLUTO attributes from NYC MapPLUTO (DOF Digital Tax Map
// geometry). The block map shades each lot's real footprint in its category color and
// makes it clickable. With lat/lng + blocks, we widen to a geographic envelope so the
// user can click any nearby property, not just same-block ones.
const MAPPLUTO =
  "https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/MAPPLUTO/FeatureServer/0/query";

// One NYC block is roughly 0.0009 deg lat (~north-south, ~260ft) and 0.0012 deg lng.
const BLOCK_LAT = 0.0009;
const BLOCK_LNG = 0.0012;

export default async (req: Request, _ctx: Context) => {
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), {
      status: s,
      headers: { "content-type": "application/json", "cache-control": "public, max-age=86400" },
    });

  const u = new URL(req.url).searchParams;
  const bbl = (u.get("bbl") || "").replace(/\D/g, "");
  if (bbl.length !== 10) return json({ error: "bbl (10 digits) required" }, 400);

  const lat = Number(u.get("lat"));
  const lng = Number(u.get("lng"));
  const blocks = Math.min(Math.max(Number(u.get("blocks")) || 0, 0), 8); // cap at 8 for safety
  const useRadius = blocks > 0 && Number.isFinite(lat) && Number.isFinite(lng);

  const base: Record<string, string> = {
    outFields: "BBL,Address,BldgClass,LotArea,NumFloors,YearBuilt,BldgArea,UnitsRes,OwnerName",
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
    resultRecordCount: "2000",
    maxAllowableOffset: "0.00002", // ~2m generalization: invisible at block zoom, smaller payload
  };

  let params: URLSearchParams;
  if (useRadius) {
    const dLat = BLOCK_LAT * blocks;
    const dLng = BLOCK_LNG * blocks;
    params = new URLSearchParams({
      ...base,
      geometry: `${lng - dLng},${lat - dLat},${lng + dLng},${lat + dLat}`,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
    });
  } else {
    // Single-block fallback: BBL range across the whole block.
    const boroBlock = bbl.slice(0, 6);
    params = new URLSearchParams({
      ...base,
      where: `BBL>=${Number(boroBlock + "0001")} AND BBL<=${Number(boroBlock + "9999")}`,
    });
  }

  let gj: any;
  try {
    const r = await fetch(`${MAPPLUTO}?${params.toString()}`);
    if (!r.ok) return json({ error: `MapPLUTO ${r.status}` }, 502);
    gj = await r.json();
  } catch (e) {
    return json({ error: `MapPLUTO request failed: ${(e as Error).message}`.slice(0, 160) }, 502);
  }

  const self = bbl;
  const lots = (gj.features || []).map((f: any) => {
    const p = f.properties || {};
    const id = String(p.BBL || "").replace(/\D/g, "").padStart(10, "0");
    const cls = String(p.BldgClass || "").toUpperCase();
    const far = p.BldgArea && p.LotArea ? Number(p.BldgArea) / Number(p.LotArea) : null;
    const vacant = cls.startsWith("V");
    let category: "self" | "opportunity" | "constrained" | "existing";
    if (id === self) category = "self";
    else if (vacant || (far !== null && far < 1)) category = "opportunity";
    else if (/^(P|Q|W|Y|Z)/.test(cls)) category = "constrained";
    else category = "existing";

    return {
      bbl: id,
      is_self: id === self,
      address: p.Address || null,
      bldg_class: p.BldgClass || null,
      lot_area: p.LotArea ?? null,
      floors: p.NumFloors ?? null,
      year_built: p.YearBuilt ?? null,
      units_res: p.UnitsRes ?? null,
      owner: p.OwnerName || null,
      category,
      geometry: f.geometry || null,
    };
  }).filter((l: any) => l.geometry);

  return json({ bbl: self, count: lots.length, radius_blocks: useRadius ? blocks : 0, lots });
};

export const config: Config = { path: "/api/lots" };
