import type { Config, Context } from "@netlify/functions";

// GET /api/landmark-search?borough=Brooklyn&zip=11238
// Dataset buis-pvji: borough uses 2-char codes (BK/MN/BX/QN/SI)
// lpc_sitest values: "Designated", "Amended", "Proposed", "Moved", "Heard"
// desdate is a text field like "4/19/1966"

const BASE = "https://data.cityofnewyork.us/resource";
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

const BORO_CODE: Record<string, string> = {
  manhattan: "MN", bronx: "BX", brooklyn: "BK", queens: "QN", "staten island": "SI",
};
const BORO_DIGIT: Record<string, string> = {
  manhattan: "1", bronx: "2", brooklyn: "3", queens: "4", "staten island": "5",
};

async function socrataGet(dataset: string, params: Record<string, string>) {
  const u = new URL(`${BASE}/${dataset}.json`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (APP_TOKEN) headers["X-App-Token"] = APP_TOKEN;
  const r = await fetch(u.toString(), { headers, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`Socrata ${dataset} ${r.status}: ${await r.text().catch(() => "")}`);
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
  const boroCode = BORO_CODE[boroughKey];
  const boroDigit = BORO_DIGIT[boroughKey];
  if (!boroCode) return json({ error: `Unknown borough: ${boroughRaw}` }, 400);

  // 1. Query LPC Individual Landmark Sites (buis-pvji) — designated only
  // lpc_sitest values: Designated, Amended, Proposed, Moved, Heard
  let lpcRows: any[];
  try {
    lpcRows = await socrataGet("buis-pvji", {
      "$where": `borough='${boroCode}' AND (lpc_sitest='Designated' OR lpc_sitest='Amended')`,
      "$select": "bbl,lpc_name,lpc_lpnumb,borough,block,lot,address,landmarkty,desdate,lpc_sitest",
      "$limit": "2000",
    });
  } catch (e) {
    return json({ error: `LPC query failed: ${(e as Error).message}` }, 502);
  }

  if (!lpcRows.length) return json({ results: [], count: 0, borough: boroughRaw, zip: zip || null });

  // Build BBL map — dataset stores BBL as text, sometimes "0" for non-lot landmarks
  const bblMap = new Map<string, any>();
  for (const row of lpcRows) {
    const rawBbl = String(row.bbl || "").replace(/\D/g, "");
    // Skip dummy BBLs (x000000000) and zero
    if (!rawBbl || rawBbl === "0" || /^[1-5]0{9}$/.test(rawBbl)) continue;
    const bbl = rawBbl.length === 10 ? rawBbl
      : (boroDigit + rawBbl.padStart(9, "0")).slice(0, 10);
    if (!bblMap.has(bbl)) bblMap.set(bbl, row);
  }

  let bbls = [...bblMap.keys()];

  // 2. Batch-query PLUTO for lot data
  const plutoMap = new Map<string, any>();
  for (const ch of chunk(bbls, 100)) {
    // PLUTO stores bbl as decimal: 3001741201.00000000 — must query as number not string
    const inClause = ch.map(b => Number(b)).join(",");
    try {
      const rows = await socrataGet("64uk-42ks", {
        "$where": `bbl in(${inClause})`,
        "$select": "bbl,address,ownername,bldgclass,lotarea,builtfar,residfar,yearbuilt,zipcode,unitsres,numfloors",
        "$limit": "500",
      });
      // Normalize PLUTO bbl back to 10-digit integer string for map lookup
      for (const r of rows) plutoMap.set(String(Math.round(Number(r.bbl))), r);
    } catch { /* degrade gracefully */ }
  }

  // 3. Merge
  let results = bbls.map(bbl => {
    const lpc = bblMap.get(bbl)!;
    const pluto = plutoMap.get(bbl);
    return {
      bbl,
      lm_name: lpc.lpc_name || null,
      lm_type: lpc.landmarkty || null,
      lpc_number: lpc.lpc_lpnumb || null,
      desig_date: lpc.desdate || null,
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

  // ZIP filter: apply only to rows that have PLUTO zip data.
  // Non-building landmarks (lampposts, bridges) have null zip and are excluded
  // when filtering by ZIP since they don't have a meaningful address ZIP.
  if (zip.length === 5) results = results.filter(r => r.zip === zip);

  // Sort: lowest built_far first (most underbuilt), nulls last
  results.sort((a, b) => {
    if (a.built_far === null && b.built_far === null) return 0;
    if (a.built_far === null) return 1;
    if (b.built_far === null) return -1;
    return a.built_far - b.built_far;
  });

  return json({ results, count: results.length, borough: boroughRaw, zip: zip || null });
};

export const config: Config = { path: "/api/landmark-search" };
