import type { Config, Context } from "@netlify/functions";

// GET /api/lots?bbl=1010740014
// Returns the tax-lot polygons for every lot on the same block, from NYC MapPLUTO
// (DOF Digital Tax Map geometry + PLUTO attributes). Used by the block map to shade
// each neighbor's real footprint in its category color instead of dropping a dot.
//
// One BBL is Borough(1) + Block(5) + Lot(4). We widen the lot part to 0001..9999 to
// pull the whole block in a single query.
const MAPPLUTO =
  "https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/MAPPLUTO/FeatureServer/0/query";

export default async (req: Request, _ctx: Context) => {
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), {
      status: s,
      headers: { "content-type": "application/json", "cache-control": "public, max-age=86400" },
    });

  const u = new URL(req.url).searchParams;
  const bbl = (u.get("bbl") || "").replace(/\D/g, "");
  if (bbl.length !== 10) return json({ error: "bbl (10 digits) required" }, 400);

  const boroBlock = bbl.slice(0, 6); // borough + 5-digit block
  const lo = Number(boroBlock + "0001");
  const hi = Number(boroBlock + "9999");

  const params = new URLSearchParams({
    where: `BBL>=${lo} AND BBL<=${hi}`,
    outFields: "BBL,Address,BldgClass,LotArea,NumFloors,YearBuilt,BldgArea,UnitsRes,OwnerName",
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
  });

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
    // Category drives the shade color, mirroring the report's own palette.
    //   iron  = built/occupied masonry (existing)   -> most lots
    //   slate = likely room to build (low far / vacant / parking)
    //   ochre = landmark/special (V = vacant is slate; we keep ochre for institutional)
    const far = p.BldgArea && p.LotArea ? Number(p.BldgArea) / Number(p.LotArea) : null;
    const vacant = cls.startsWith("V");
    let category: "self" | "opportunity" | "constrained" | "existing";
    if (id === self) category = "self";
    else if (vacant || (far !== null && far < 1)) category = "opportunity";
    else if (/^(P|Q|W|Y|Z)/.test(cls)) category = "constrained"; // parking, institutional, misc
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
      geometry: f.geometry || null, // GeoJSON Polygon/MultiPolygon in lon/lat
    };
  }).filter((l: any) => l.geometry);

  return json({ bbl: self, count: lots.length, lots });
};

export const config: Config = { path: "/api/lots" };
