import type { Config, Context } from "@netlify/functions";

// GET /api/landmark-search?borough=Brooklyn&zip=11238&status=designated
// Returns all LPC-designated individual landmarks in the area enriched with
// PLUTO lot data. Dataset: buis-pvji (Individual Landmark Sites, has bbl field).
// Fields: bbl, lpc_name, lpc_lpnumb, borough, block, lot, address,
//         landmarkty, desdate, lpc_sitede, lpc_sitest

const BASE = "https://data.cityofnewyork.us/resource";
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

const BORO_DIGIT: Record<string, string> = {
  manhattan: "1", bronx: "2", brooklyn: "3", queens: "4", "staten island": "5",
};
// LPC uses full borough names in this dataset
const BORO_LPC: Record<string, string> = {
  manhattan: "Manhattan", bronx: "Bronx", brooklyn: "Brooklyn",
  queens: "Queens", "staten island": "Staten Island",
};

async function socrataGet(dataset: string, params: Record<string, string>) {
  const u = new URL(`${BASE}/${dataset}.json`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (APP_TOKEN) headers["X-App-Token"] = APP_TOKEN;
  const r = await fetch(u.toString(), { headers, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`Socrata ${dataset} ${r.status}: ${await r.text().catch(()=>"")}`);
  return r.json() as Promise<any[]>;
}

function chunk<T>(xs: T[], n = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export default async (req: Request, _ctx: Context) => {
  const u = new URL(req.url);
  const boroughRaw = (u.searchParams.get("borough") || "Brooklyn").trim();
  const zip = (u.searchParams.get("zip") || "").replace(/\D/g, "");

  const boroughKey = boroughRaw.toLowerCase();
  const boroDigit = BORO_DIGIT[boroughKey];
  if (!boroDigit) return json({ error: `Unknown borough: ${boroughRaw}` }, 400);
  const boroughLPC = BORO_LPC[boroughKey];

  // 1. Query LPC Individual Landmark Sites (buis-pvji) by borough
  let lpcRows: any[];
  try {
    lpcRows = await socrataGet("buis-pvji", {
      "$where": `borough='${boroughLPC}'`,
      "$select": "bbl,lpc_name,lpc_lpnumb,borough,block,lot,address,landmarkty,desdate",
      "$limit": "2000",
    });
  } catch (e) {
    return json({ error: `LPC query failed: ${(e as Error).message}` }, 502);
  }

  if (!lpcRows.length) return json({ results: [], count: 0, borough: boroughRaw, zip: zip || null });

  // Build BBL map — normalize to 10-digit string
  const bblMap = new Map<string, any>();
  for (const row of lpcRows) {
    let bbl = String(row.bbl || "").replace(/\D/g, "");
    if (!bbl) {
      // Fallback: construct from boro+block+lot
      const b = String(row.block || "").padStart(5, "0");
      const l = String(row.lot || "").padStart(4, "0");
      bbl = boroDigit + b + l;
    }
    if (bbl.length !== 10) continue;
    if (!bblMap.has(bbl)) bblMap.set(bbl, row);
  }

  let bbls = [...bblMap.keys()];

  // 2. Batch-query PLUTO for lot data
  const plutoMap = new Map<string, any>();
  for (const ch of chunk(bbls, 100)) {
    const inClause = ch.map(b => `'${b}'`).join(",");
    try {
      const rows = await socrataGet("64uk-42ks", {
        "$where": `bbl in(${inClause})`,
        "$select": "bbl,address,ownername,bldgclass,lotarea,builtfar,residfar,commfar,yearbuilt,zipcode,unitsres,numfloors",
        "$limit": "500",
      });
      for (const r of rows) plutoMap.set(String(r.bbl), r);
    } catch { /* degrade gracefully */ }
  }

  // 3. Merge and filter by ZIP if provided
  let results = bbls.map(bbl => {
    const lpc = bblMap.get(bbl)!;
    const pluto = plutoMap.get(bbl);
    return {
      bbl,
      lm_name: lpc.lpc_name || lpc.lm_name || null,
      lm_type: lpc.landmarkty || null,
      lpc_number: lpc.lpc_lpnumb || null,
      desig_date: lpc.desdate ? String(lpc.desdate).slice(0, 10) : null,
      address: pluto?.address || lpc.address || null,
      owner: pluto?.ownername || null,
      bldg_class: pluto?.bldgclass || null,
      lot_area: pluto?.lotarea ? Math.round(Number(pluto.lotarea)) : null,
      built_far: pluto?.builtfar != null ? Math.round(Number(pluto.builtfar) * 100) / 100 : null,
      max_res_far: pluto?.residfar != null ? Math.round(Number(pluto.residfar) * 100) / 100 : null,
      year_built: pluto?.yearbuilt || null,
      zip: pluto?.zipcode || null,
      units_res: pluto?.unitsres ? Number(pluto.unitsres) : null,
      floors: pluto?.numfloors ? Math.round(Number(pluto.numfloors) * 10) / 10 : null,
    };
  });

  if (zip.length === 5) results = results.filter(r => r.zip === zip);

  // Sort: underbuilt first (lowest built_far), nulls last
  results.sort((a, b) => {
    if (a.built_far === null && b.built_far === null) return 0;
    if (a.built_far === null) return 1;
    if (b.built_far === null) return -1;
    return a.built_far - b.built_far;
  });

  return json({ results, count: results.length, borough: boroughRaw, zip: zip || null });
};

export const config: Config = { path: "/api/landmark-search" };
