import type { Config, Context } from "@netlify/functions";

// GET /api/search?mode=<owner|zip|block|filter>&...  -> up to 60 matching lots
//
// Backs the Search tab. All modes query PLUTO (64uk-42ks) via Socrata SoQL and return
// a compact list the frontend renders as clickable rows (each opens that lot's report).
//   owner  : q=<owner name>                         (LIKE, case-insensitive)
//   zip    : zip=<5-digit>                          (optionally + filters below)
//   cd     : cd=<3-digit community district>
//   block  : bbl=<10-digit> or boro+block
//   filter : any of zip/cd/borough + vacant=1, minlot=, maxlot=, class=, yearmin=, yearmax=, unitsmin=
const PLUTO = "https://data.cityofnewyork.us/resource/64uk-42ks.json";
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN;

const esc = (s: string) => String(s).replace(/'/g, "''"); // SoQL string escaping

export default async (req: Request, _ctx: Context) => {
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

  const u = new URL(req.url).searchParams;
  const mode = (u.get("mode") || "").toLowerCase();
  const clauses: string[] = [];

  if (mode === "owner") {
    const q = (u.get("q") || "").trim();
    if (q.length < 3) return json({ error: "Enter at least 3 characters of the owner name." }, 400);
    clauses.push(`upper(ownername) like '%${esc(q.toUpperCase())}%'`);
  } else if (mode === "zip") {
    const zip = (u.get("zip") || "").replace(/\D/g, "");
    if (zip.length !== 5) return json({ error: "Enter a 5-digit ZIP." }, 400);
    clauses.push(`zipcode='${esc(zip)}'`);
  } else if (mode === "cd") {
    const cd = (u.get("cd") || "").replace(/\D/g, "");
    if (!cd) return json({ error: "Enter a community district (e.g. 304)." }, 400);
    clauses.push(`cd=${Number(cd)}`);
  } else if (mode === "block") {
    const bbl = (u.get("bbl") || "").replace(/\D/g, "");
    if (bbl.length === 10) {
      const lo = Number(bbl.slice(0, 6) + "0001"), hi = Number(bbl.slice(0, 6) + "9999");
      clauses.push(`bbl>=${lo} AND bbl<=${hi}`);
    } else {
      const boro = (u.get("borough") || "").replace(/\D/g, ""), block = (u.get("block") || "").replace(/\D/g, "");
      if (!boro || !block) return json({ error: "Provide a 10-digit BBL, or borough + block." }, 400);
      const bb = boro + String(block).padStart(5, "0");
      clauses.push(`bbl>=${Number(bb + "0001")} AND bbl<=${Number(bb + "9999")}`);
    }
  } else if (mode === "filter") {
    const zip = (u.get("zip") || "").replace(/\D/g, "");
    const cd = (u.get("cd") || "").replace(/\D/g, "");
    const boro = (u.get("borough") || "").replace(/\D/g, "");
    if (zip.length === 5) clauses.push(`zipcode='${esc(zip)}'`);
    if (cd) clauses.push(`cd=${Number(cd)}`);
    if (boro) clauses.push(`borocode=${Number(boro)}`);
    if (u.get("vacant") === "1") clauses.push(`starts_with(bldgclass,'V')`);
    const cls = (u.get("class") || "").trim().toUpperCase();
    if (cls) clauses.push(`starts_with(bldgclass,'${esc(cls)}')`);
    const minlot = Number(u.get("minlot")); if (minlot > 0) clauses.push(`lotarea>=${minlot}`);
    const maxlot = Number(u.get("maxlot")); if (maxlot > 0) clauses.push(`lotarea<=${maxlot}`);
    const yearmin = Number(u.get("yearmin")); if (yearmin > 0) clauses.push(`yearbuilt>=${yearmin}`);
    const yearmax = Number(u.get("yearmax")); if (yearmax > 0) clauses.push(`yearbuilt<=${yearmax}`);
    const unitsmin = Number(u.get("unitsmin")); if (unitsmin > 0) clauses.push(`unitsres>=${unitsmin}`);
    if (!clauses.length) return json({ error: "Pick at least one filter (ZIP, community district, borough, vacant, class, size, year, or units)." }, 400);
  } else if (mode === "distress") {
    // Distressed properties from the DOF Tax Lien Sale List (9rz4-mjek), filtered by area.
    // kind=tax  -> water_debt_only='NO' (tax arrears)
    // kind=water-> water_debt_only='YES' (water/sewer arrears)
    // kind=all  -> both
    const LIEN = "https://data.cityofnewyork.us/resource/9rz4-mjek.json";
    const lc: string[] = [];
    const zip = (u.get("zip") || "").replace(/\D/g, "");
    const cd = (u.get("cd") || "").replace(/\D/g, "");
    const boro = (u.get("borough") || "").replace(/\D/g, "");
    if (zip.length === 5) lc.push(`zip_code='${esc(zip)}'`);
    if (cd) lc.push(`community_board='${esc(cd)}'`);
    if (boro) lc.push(`borough='${esc(boro)}'`);
    const kind = (u.get("kind") || "all").toLowerCase();
    if (kind === "water") lc.push(`upper(water_debt_only)='YES'`);
    else if (kind === "tax") lc.push(`upper(water_debt_only)='NO'`);
    if (!lc.length) return json({ error: "Pick a borough, ZIP, or community district to search liens." }, 400);

    const lp = new URLSearchParams({
      $select: "borough,block,lot,house_number,street_name,zip_code,cycle,water_debt_only,building_class,community_board",
      $where: lc.join(" AND "),
      $order: "month DESC",
      $limit: "60",
    });
    if (APP_TOKEN) lp.set("$$app_token", APP_TOKEN);

    let lrows: any[];
    try {
      const r = await fetch(`${LIEN}?${lp.toString()}`);
      if (!r.ok) return json({ error: `Lien list ${r.status}` }, 502);
      lrows = await r.json();
    } catch (e) {
      return json({ error: `Lien search failed: ${(e as Error).message}`.slice(0, 160) }, 502);
    }
    // Group liens by building. Condo unit lots (1001-6999) all belong to one condominium;
    // liens attach to the units, but PLUTO only indexes the billing BBL (75xx). So we roll
    // every lien'd unit up to its building — keyed by borough+block+address — and resolve the
    // report link to a real, PLUTO-queryable BBL (the billing 75xx lot, or the fee lot itself).
    type Grp = { key: string; borough: string; block: string; sampleLot: string; address: string;
      isCondo: boolean; bldg_class: string | null; zip: string | null; water: boolean; tax: boolean;
      cycle: string | null; unitCount: number };
    const groups = new Map<string, Grp>();
    for (const r of lrows) {
      const b = String(r.borough || "").replace(/\D/g, "");
      const blk = String(r.block || "").replace(/\D/g, "").padStart(5, "0");
      const ltNum = Number(String(r.lot || "").replace(/\D/g, ""));
      const lt = String(ltNum).padStart(4, "0");
      if (!b || !blk || !ltNum) continue;
      const addr = [r.house_number, r.street_name].filter(Boolean).join(" ").trim().toUpperCase();
      const isCondo = ltNum >= 1001 && ltNum <= 6999; // condo unit lot
      // Condo units group by building (borough+block+address); fee lots stay individual.
      const key = isCondo ? `${b}|${blk}|${addr}` : `${b}${blk}${lt}`;
      const water = String(r.water_debt_only || "").toUpperCase() === "YES";
      const g = groups.get(key);
      if (g) {
        g.unitCount++;
        if (water) g.water = true; else g.tax = true;
      } else {
        groups.set(key, {
          key, borough: b, block: blk, sampleLot: lt,
          address: [r.house_number, r.street_name].filter(Boolean).join(" ") || (b + blk + lt),
          isCondo, bldg_class: r.building_class || null, zip: r.zip_code || null,
          water, tax: !water, cycle: r.cycle || null, unitCount: 1,
        });
      }
    }

    // For each condo group, resolve the building's billing BBL (75xx on the block whose address
    // matches). One PLUTO call per block covers all its condos.
    const condoBlocks = [...new Set([...groups.values()].filter(g => g.isCondo).map(g => g.borough + g.block))];
    const billingByAddr = new Map<string, string>(); // "boroblock|ADDRESS" -> billing bbl
    await Promise.all(condoBlocks.map(async (bb) => {
      try {
        const lo = Number(bb + "7501"), hi = Number(bb + "7599");
        const q = new URLSearchParams({ $select: "bbl,address", $where: `bbl>=${lo} AND bbl<=${hi}`, $limit: "50" });
        if (APP_TOKEN) q.set("$$app_token", APP_TOKEN);
        const rr = await fetch(`${PLUTO}?${q.toString()}`);
        if (!rr.ok) return;
        for (const row of await rr.json()) {
          const bill = String(row.bbl || "").split(".")[0].padStart(10, "0");
          const a = String(row.address || "").trim().toUpperCase();
          if (a) billingByAddr.set(`${bb}|${a}`, bill);
        }
      } catch { /* leave unresolved */ }
    }));

    const results = [...groups.values()].map((g) => {
      let bbl = g.borough + g.block + g.sampleLot;
      let note = "";
      if (g.isCondo) {
        const bill = billingByAddr.get(`${g.borough}${g.block}|${g.address.toUpperCase()}`);
        if (bill) bbl = bill; // point to the building's PLUTO-resolvable billing BBL
        note = ` · ${g.unitCount} condo unit${g.unitCount > 1 ? "s" : ""} with liens`;
      }
      const lien_type = g.water && g.tax ? "Tax + water liens" : g.water ? "Water/sewer lien" : "Tax lien";
      return {
        bbl,
        address: g.address,
        owner: null,
        bldg_class: g.bldg_class,
        lot_area: null, units_res: null, year_built: null,
        zip: g.zip,
        lien_type: lien_type + note,
        cycle: g.cycle,
        is_condo: g.isCondo,
      };
    });
    return json({ mode, kind, count: results.length, results });
  } else {
    return json({ error: "Unknown search mode." }, 400);
  }

  const params = new URLSearchParams({
    $select: "bbl,address,ownername,bldgclass,lotarea,unitsres,yearbuilt,zipcode,latitude,longitude",
    $where: clauses.join(" AND "),
    $order: "lotarea DESC",
    $limit: "60",
  });
  if (APP_TOKEN) params.set("$$app_token", APP_TOKEN);

  let rows: any[];
  try {
    const r = await fetch(`${PLUTO}?${params.toString()}`);
    if (!r.ok) return json({ error: `PLUTO ${r.status}: ${(await r.text()).slice(0, 140)}` }, 502);
    rows = await r.json();
  } catch (e) {
    return json({ error: `Search request failed: ${(e as Error).message}`.slice(0, 160) }, 502);
  }

  const results = rows.map((r) => ({
    bbl: String(r.bbl || "").split(".")[0].padStart(10, "0"),
    address: r.address || null,
    owner: r.ownername || null,
    bldg_class: r.bldgclass || null,
    lot_area: r.lotarea ? Math.round(Number(r.lotarea)) : null,
    units_res: r.unitsres ?? null,
    year_built: r.yearbuilt ?? null,
    zip: r.zipcode || null,
  }));

  return json({ mode, count: results.length, results });
};

export const config: Config = { path: "/api/search" };
