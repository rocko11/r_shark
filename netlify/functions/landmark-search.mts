import type { Config, Context } from "@netlify/functions";

// GET /api/landmark-search?borough=Brooklyn&zip=11238&status=DESIGNATED
// Returns all LPC-designated landmarks in the area, enriched with PLUTO
// lot data (size, built FAR, owner) so you can spot underbuilt ones.
// borough: Brooklyn | Manhattan | Queens | Bronx | Staten Island
// zip: optional 5-digit ZIP (filters via bbl prefix match on PLUTO side)
// status: DESIGNATED (default) | CALENDARED | all

const BASE = "https://data.cityofnewyork.us/resource";
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

// Borough name -> PLUTO borough digit
const BORO_DIGIT: Record<string, string> = {
  manhattan: "1", bronx: "2", brooklyn: "3", queens: "4", "staten island": "5",
};

async function socrataGet(dataset: string, params: Record<string, string>) {
  const u = new URL(`${BASE}/${dataset}.json`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (APP_TOKEN) headers["X-App-Token"] = APP_TOKEN;
  const r = await fetch(u.toString(), { headers, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`Socrata ${dataset} ${r.status}`);
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
  const statusFilter = (u.searchParams.get("status") || "DESIGNATED").toUpperCase();

  const boroughKey = boroughRaw.toLowerCase();
  const boroDigit = BORO_DIGIT[boroughKey];
  if (!boroDigit) return json({ error: `Unknown borough: ${boroughRaw}` }, 400);

  // Capitalize for LPC borough field (e.g. "Brooklyn")
  const boroughLPC = boroughRaw.charAt(0).toUpperCase() + boroughRaw.slice(1).toLowerCase();
  // "Staten Island" fix
  const boroughLPCFull = boroughKey === "staten island" ? "Staten Island" : boroughLPC;

  // 1. Query LPC for all landmarks in the borough
  const lpcWhere = statusFilter === "ALL"
    ? `borough='${boroughLPCFull}'`
    : `borough='${boroughLPCFull}' AND status='${statusFilter}'`;

  let lpcRows: any[];
  try {
    lpcRows = await socrataGet("jpkn-3nnt", {
      "$where": lpcWhere,
      "$select": "bbl,lm_name,lm_type,status,desig_date,borough,block,lot",
      "$limit": "1000",
    });
  } catch (e) {
    return json({ error: `LPC query failed: ${(e as Error).message}` }, 502);
  }

  if (!lpcRows.length) return json({ results: [], count: 0, borough: boroughRaw, zip: zip || null });

  // Normalize BBLs (LPC stores them without leading zeros sometimes)
  const bblMap = new Map<string, any>();
  for (const row of lpcRows) {
    const rawBbl = String(row.bbl || "").replace(/\D/g, "");
    if (!rawBbl) continue;
    // Pad to 10 digits with borough prefix
    const bbl = rawBbl.length === 10 ? rawBbl : (boroDigit + rawBbl.padStart(9, "0")).slice(0, 10);
    if (!bblMap.has(bbl)) bblMap.set(bbl, row);
  }

  let bbls = [...bblMap.keys()];

  // 2. Batch-query PLUTO to get lot data
  const plutoMap = new Map<string, any>();
  for (const chunk of chunk(bbls, 100)) {
    const inClause = chunk.map(b => `'${b}'`).join(",");
    try {
      const rows = await socrataGet("64uk-42ks", {
        "$where": `bbl in(${inClause})`,
        "$select": "bbl,address,ownername,bldgclass,lotarea,builtfar,residfar,commfar,yearbuilt,zipcode,unitsres,numfloors",
        "$limit": "500",
      });
      for (const r of rows) plutoMap.set(String(r.bbl), r);
    } catch { /* degrade gracefully — PLUTO enrichment optional */ }
  }

  // 3. Filter by ZIP if provided (PLUTO zipcode field)
  let results = bbls.map(bbl => {
    const lpc = bblMap.get(bbl)!;
    const pluto = plutoMap.get(bbl);
    return {
      bbl,
      lm_name: lpc.lm_name || null,
      lm_type: lpc.lm_type || null,
      status: lpc.status || null,
      desig_date: lpc.desig_date ? String(lpc.desig_date).slice(0, 10) : null,
      address: pluto?.address || null,
      owner: pluto?.ownername || null,
      bldg_class: pluto?.bldgclass || null,
      lot_area: pluto?.lotarea ? Math.round(Number(pluto.lotarea)) : null,
      built_far: pluto?.builtfar ? Math.round(Number(pluto.builtfar) * 100) / 100 : null,
      max_res_far: pluto?.residfar ? Math.round(Number(pluto.residfar) * 100) / 100 : null,
      year_built: pluto?.yearbuilt || null,
      zip: pluto?.zipcode || null,
      units_res: pluto?.unitsres ? Number(pluto.unitsres) : null,
      floors: pluto?.numfloors ? Math.round(Number(pluto.numfloors) * 10) / 10 : null,
    };
  });

  if (zip.length === 5) {
    results = results.filter(r => r.zip === zip);
  }

  // Sort: underbuilt first (built_far ascending), nulls last
  results.sort((a, b) => {
    if (a.built_far === null && b.built_far === null) return 0;
    if (a.built_far === null) return 1;
    if (b.built_far === null) return -1;
    return a.built_far - b.built_far;
  });

  return json({ results, count: results.length, borough: boroughRaw, zip: zip || null });
};

export const config: Config = { path: "/api/landmark-search" };
