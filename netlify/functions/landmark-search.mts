import type { Config, Context } from "@netlify/functions";

// GET /api/landmark-search?borough=Brooklyn&zip=11222
// Returns:
//   1) LPC individually designated landmarks in the borough (buis-pvji)
//   2) Buildings in LPC historic districts from PLUTO's histdist field
// Both enriched with PLUTO lot data. ZIP filter applies to both.

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
const BORO_PLUTO: Record<string, string> = {
  manhattan: "MN", bronx: "BX", brooklyn: "BK", queens: "QN", "staten island": "SI",
};

async function socrataGet(dataset: string, params: Record<string, string>) {
  const u = new URL(`${BASE}/${dataset}.json`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (APP_TOKEN) headers["X-App-Token"] = APP_TOKEN;
  const r = await fetch(u.toString(), { headers, signal: AbortSignal.timeout(15000) });
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
  const boroPluto = BORO_PLUTO[boroughKey];
  if (!boroCode) return json({ error: `Unknown borough: ${boroughRaw}` }, 400);

  const results: any[] = [];

  // ── 1. PLUTO: historic district buildings (histdist IS NOT NULL) ──────────
  // PLUTO stores BBL as float (e.g. 3001741201.00000000), borough as "BK" etc.
  try {
    const plutoWhere = zip.length === 5
      ? `borough='${boroPluto}' AND histdist IS NOT NULL AND zipcode='${zip}'`
      : `borough='${boroPluto}' AND histdist IS NOT NULL`;

    const rows = await socrataGet("64uk-42ks", {
      "$where": plutoWhere,
      "$select": "bbl,address,ownername,bldgclass,lotarea,builtfar,residfar,yearbuilt,zipcode,unitsres,numfloors,histdist",
      "$limit": "2000",
    });

    for (const r of rows) {
      const bbl = String(Math.round(Number(r.bbl)));
      results.push({
        bbl,
        lm_name: r.histdist || "Historic District Building",
        lm_type: "Historic District",
        lpc_number: null,
        desig_date: null,
        address: r.address || null,
        owner: r.ownername || null,
        bldg_class: r.bldgclass || null,
        lot_area: r.lotarea ? Math.round(Number(r.lotarea)) : null,
        built_far: r.builtfar != null ? Math.round(Number(r.builtfar) * 100) / 100 : null,
        max_res_far: r.residfar != null ? Math.round(Number(r.residfar) * 100) / 100 : null,
        year_built: r.yearbuilt || null,
        zip: r.zipcode || null,
        units_res: r.unitsres ? Number(r.unitsres) : null,
        floors: r.numfloors ? Math.round(Number(r.numfloors) * 10) / 10 : null,
      });
    }
  } catch (e) {
    console.error("PLUTO histdist query failed:", (e as Error).message);
  }

  // ── 2. Individual LPC landmarks (buis-pvji) ───────────────────────────────
  try {
    const lpcRows = await socrataGet("buis-pvji", {
      "$where": `borough='${boroCode}' AND (lpc_sitest='Designated' OR lpc_sitest='Amended')`,
      "$select": "bbl,lpc_name,lpc_lpnumb,borough,block,lot,address,landmarkty,desdate,lpc_sitest",
      "$limit": "2000",
    });

    // Build BBL set already in results to avoid duplicates
    const existingBBLs = new Set(results.map(r => r.bbl));

    // Collect BBLs to enrich from PLUTO
    const indivMap = new Map<string, any>();
    for (const row of lpcRows) {
      const rawBbl = String(row.bbl || "").replace(/\D/g, "");
      if (!rawBbl || rawBbl === "0" || /^[1-5]0{9}$/.test(rawBbl)) continue;
      const bbl = rawBbl.length === 10 ? rawBbl
        : (boroDigit + rawBbl.padStart(9, "0")).slice(0, 10);
      if (!indivMap.has(bbl)) indivMap.set(bbl, row);
    }

    // PLUTO enrich the individual landmarks
    const plutoMap = new Map<string, any>();
    for (const ch of chunk([...indivMap.keys()], 100)) {
      const inClause = ch.map(b => Number(b)).join(",");
      try {
        const rows = await socrataGet("64uk-42ks", {
          "$where": `bbl in(${inClause})`,
          "$select": "bbl,address,ownername,bldgclass,lotarea,builtfar,residfar,yearbuilt,zipcode,unitsres,numfloors",
          "$limit": "500",
        });
        for (const r of rows) plutoMap.set(String(Math.round(Number(r.bbl))), r);
      } catch { /* degrade */ }
    }

    for (const [bbl, lpc] of indivMap) {
      if (existingBBLs.has(bbl)) continue; // skip if already in historic district results
      const pluto = plutoMap.get(bbl);
      // Apply ZIP filter for individual landmarks
      if (zip.length === 5 && pluto?.zipcode && pluto.zipcode !== zip) continue;
      results.push({
        bbl,
        lm_name: lpc.lpc_name || null,
        lm_type: "Individual Landmark",
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
      });
    }
  } catch (e) {
    console.error("LPC individual query failed:", (e as Error).message);
  }

  // Sort: underbuilt first (lowest built_far), then nulls
  results.sort((a, b) => {
    if (a.built_far === null && b.built_far === null) return 0;
    if (a.built_far === null) return 1;
    if (b.built_far === null) return -1;
    return a.built_far - b.built_far;
  });

  return json({ results, count: results.length, borough: boroughRaw, zip: zip || null });
};

export const config: Config = { path: "/api/landmark-search" };
