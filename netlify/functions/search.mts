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
