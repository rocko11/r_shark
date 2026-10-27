// Environmental screen for a property: flood zone, contamination on / near the lot,
// zoning environmental restrictions and recorded spills. Everything is pulled live from
// public government sources by point (lat/lon) and, where the source is keyed that way,
// by BBL or street address. It is a desktop screen to decide whether a deal needs a
// Phase I ESA early — not a Phase I.
//
// Sources (all verified 2026-10-26):
//   FEMA NFHL effective flood zones ........ hazards.fema.gov NFHL/MapServer/28
//   FEMA preliminary flood zones ........... hazards.fema.gov PrelimPending/Prelim_NFHL/MapServer/21
//                                            (NYC's 2015 PFIRM — the building code uses the stricter of the two)
//   NYC E-designations (DCP) ............... data.cityofnewyork.us hxm3-23vy   (by BBL)
//   NYC OER cleanup sites .................. data.cityofnewyork.us 3279-pp7v   (by point)
//   NYS DEC environmental remediation ...... data.ny.gov c6ci-rzpg             (State Superfund, BCP, VCP, ERP, RCRA)
//   NYS DEC spill incidents ................ data.ny.gov u44d-k5fk             (by street address — the set has no coordinates)
//   NJDEP Known Contaminated Sites ......... mapsdep.nj.gov Environmental_NJEMS/MapServer/0
//   EPA Superfund (NPL) .................... services.arcgis.com EPA NPL sites w/ status

const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || "";
const FEMA_EFF = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query";
const FEMA_PRELIM = "https://hazards.fema.gov/arcgis/rest/services/PrelimPending/Prelim_NFHL/MapServer/21/query";
const NYC_EDESIG = "https://data.cityofnewyork.us/resource/hxm3-23vy.json";
const NYC_OER = "https://data.cityofnewyork.us/resource/3279-pp7v.json";
const NYS_REMED = "https://data.ny.gov/resource/c6ci-rzpg.json";
const NYS_SPILLS = "https://data.ny.gov/resource/u44d-k5fk.json";
const NJ_KCS = "https://mapsdep.nj.gov/arcgis/rest/services/Features/Environmental_NJEMS/MapServer/0/query";
const EPA_NPL = "https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/Superfund_National_Priorities_List_(NPL)_Sites_with_Status_Information/FeatureServer/0/query";

const NEAR_M = 400;      // "nearby" contamination radius
const ON_LOT_M = 15;     // a site point this close is treated as on the lot (else an address match is required)
const NPL_M = 1609;      // Superfund sites within a mile

async function getJSON(url: string, ms = 7000): Promise<any> {
  const socrata = /data\.(cityofnewyork\.us|ny\.gov)\/resource/.test(url);
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: socrata && APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {} });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j && j.error && !Array.isArray(j)) throw new Error(j.error.message || j.message || "service error");
  return j;
}
const soql = (base: string, p: Record<string, string>) => `${base}?${new URLSearchParams(p)}`;
const arcPoint = (base: string, lat: number, lon: number, extra: Record<string, string>) =>
  `${base}?${new URLSearchParams({ geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
    spatialRel: "esriSpatialRelIntersects", returnGeometry: "false", f: "json", ...extra })}`;

export function metersBetween(a: [number, number], b: [number, number]) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
const iso = (v: any) => {
  if (v == null || v === "") return null;
  const d = typeof v === "number" ? new Date(v) : new Date(String(v));
  return isNaN(+d) ? null : d.toISOString().slice(0, 10);
};

/* ---------------- flood ---------------- */
const ZONE_TXT: Record<string, string> = {
  V: "Coastal high-hazard (wave action)", VE: "Coastal high-hazard (wave action)",
  A: "1% annual-chance flood (100-year)", AE: "1% annual-chance flood (100-year)", AO: "1% annual-chance shallow flooding",
  AH: "1% annual-chance ponding", AR: "Flood-control restoration area", A99: "Protected by levee under construction",
  X: "Outside the 100-year floodplain", D: "Undetermined flood hazard",
};
function floodRow(f: any) {
  const a = f.attributes || {};
  const zone = String(a.FLD_ZONE || "").trim();
  const sub = String(a.ZONE_SUBTY || "").trim();
  const bfe = Number(a.STATIC_BFE);
  const x500 = zone === "X" && /0\.2 PCT|500/i.test(sub);
  return {
    zone, subtype: sub || null, sfha: a.SFHA_TF === "T",
    bfe_ft: bfe > -9000 ? bfe : null,
    label: x500 ? "0.2% annual-chance flood (500-year)" : (ZONE_TXT[zone] || zone),
    level: a.SFHA_TF === "T" ? "high" : x500 ? "moderate" : "low",
  };
}
async function flood(lat: number, lon: number) {
  const fields = { outFields: "FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,DFIRM_ID" };
  // hazards.fema.gov drops connections now and then — one quick retry fixes almost all of it
  // (the whole function has to finish inside Netlify's 10 s limit).
  const tryTwice = async (url: string) => { try { return await getJSON(url, 4500); } catch { return await getJSON(url, 4000); } };
  const [eff, pre] = await Promise.allSettled([
    tryTwice(arcPoint(FEMA_EFF, lat, lon, fields)),
    tryTwice(arcPoint(FEMA_PRELIM, lat, lon, fields)),
  ]);
  if (eff.status === "rejected" && pre.status === "rejected") throw new Error("FEMA flood service unavailable");
  // A point on a zone line can return two polygons — keep the riskier one.
  const worst = (fs: any[]) => fs.map(floodRow).sort((a, b) => Number(b.sfha) - Number(a.sfha) || (b.bfe_ft || 0) - (a.bfe_ft || 0))[0] || null;
  return {
    effective: eff.status === "fulfilled" ? worst(eff.value.features || []) : null,
    preliminary: pre.status === "fulfilled" ? worst(pre.value.features || []) : null,
  };
}

/* ---------------- NYC E-designations (by BBL) ---------------- */
async function eDesignations(bbl: string) {
  const rows = await getJSON(soql(NYC_EDESIG, { bbl, $limit: "20" }));
  const seen = new Set<string>();
  return (rows || []).filter((r: any) => !seen.has(r.enumber + r.description) && seen.add(r.enumber + r.description)).map((r: any) => ({
    number: r.enumber, effective: iso(r.effective_date), description: r.description || null,
    hazmat: r.hazmat_code === true || r.hazmat_code === "true",
    air: r.air_code === true || r.air_code === "true",
    noise: r.noise_code === true || r.noise_code === "true",
    ceqr: r.ceqr_num || null, ulurp: r.ulurp_num || null,
  }));
}

/* ---------------- NYC OER cleanups (by point, plus "this BBL") ---------------- */
async function oerSites(lat: number, lon: number, bbl?: string, address?: string) {
  const dLat = NEAR_M / 111320, dLon = NEAR_M / (111320 * Math.cos(lat * Math.PI / 180));
  const box = `latitude::number between ${lat - dLat} and ${lat + dLat} and longitude::number between ${lon - dLon} and ${lon + dLon}`;
  const where = bbl ? `(${box}) or bbl like '%${bbl}%'` : box;
  const rows = await getJSON(soql(NYC_OER, { $where: where, $limit: "200" }));
  return (rows || []).map((r: any) => {
    const onLot = (!!bbl && String(r.bbl || "").split(/[,\s]+/).includes(bbl)) || sameAddress(address, [r.street_number, r.street_name].filter(Boolean).join(" "));
    const p: [number, number] | null = r.latitude ? [Number(r.latitude), Number(r.longitude)] : null;
    return {
      name: r.project_name, address: [r.street_number, r.street_name].filter(Boolean).join(" ") || null,
      program: r.oer_program || null, status: r.phase || r.class || null,
      on_lot: onLot, distance_m: onLot ? 0 : p ? metersBetween([lat, lon], p) : null,
      url: r.project_specific_document?.url || null, numbers: r.oer_project_numbers || null,
    };
  }).filter((s: any) => s.on_lot || (s.distance_m != null && s.distance_m <= NEAR_M))
    .sort((a: any, b: any) => a.distance_m - b.distance_m);
}

/* ---------------- NYS DEC remediation sites (NYC + rest of state) ---------------- */
const NYS_PROGRAM: Record<string, string> = {
  HW: "State Superfund", BCP: "Brownfield Cleanup Program", VCP: "Voluntary Cleanup",
  ERP: "Environmental Restoration (municipal brownfield)", RCRA: "Hazardous waste facility (RCRA)",
};
const NYS_CLASS: Record<string, string> = {
  "01": "Class 1 — imminent danger", "02": "Class 2 — significant threat", "03": "Class 3 — not a significant threat",
  "04": "Class 4 — closed, needs site management", "05": "Class 5 — closed, no further action",
  A: "Active remediation", C: "Remediation complete", N: "No further action", P: "Potential site (under investigation)",
  PR: "Potential RCRA site", D: "Delisted", R: "RCRA closure",
};
async function nysRemediation(lat: number, lon: number, address?: string) {
  const rows = await getJSON(soql(NYS_REMED, {
    $select: "program_number,program_type,program_facility_name,siteclass,address1,locality,latitude,longitude,project_name,project_completion_date",
    $where: `within_circle(georeference, ${lat}, ${lon}, ${NEAR_M})`, $limit: "500",
  }));
  const by = new Map<string, any>();
  for (const r of rows || []) {
    const k = r.program_number;
    const d = r.latitude ? metersBetween([lat, lon], [Number(r.latitude), Number(r.longitude)]) : null;
    const cur = by.get(k);
    if (!cur) by.set(k, {
      name: r.program_facility_name, address: r.address1 || null, locality: r.locality || null,
      program: NYS_PROGRAM[r.program_type] || r.program_type, program_code: r.program_type,
      class: NYS_CLASS[String(r.siteclass || "").toUpperCase()] || r.siteclass || null, class_code: r.siteclass || null,
      number: k, distance_m: d, on_lot: (d != null && d <= ON_LOT_M) || sameAddress(address, r.address1), phases: 1,
      url: `https://extapps.dec.ny.gov/cfmx/extapps/derexternal/haz/details.cfm?ProgNo=${encodeURIComponent(k)}`,
    });
    else cur.phases++;
  }
  return [...by.values()].sort((a, b) => (a.distance_m ?? 9e9) - (b.distance_m ?? 9e9));
}

/* ---------------- NYS DEC spills (by street address) ---------------- */
const NYC_COUNTY: Record<string, string> = { "1": "New York", "2": "Bronx", "3": "Kings", "4": "Queens", "5": "Richmond" };
const ORD: Record<string, string> = { FIRST: "1", SECOND: "2", THIRD: "3", FOURTH: "4", FIFTH: "5", SIXTH: "6", SEVENTH: "7", EIGHTH: "8", NINTH: "9", TENTH: "10", ELEVENTH: "11", TWELFTH: "12" };
const DIRS = new Set(["N", "S", "E", "W", "NORTH", "SOUTH", "EAST", "WEST"]);
export function spillKey(address: string) {
  const a = String(address || "").toUpperCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
  const m = a.match(/^(\d+[A-Z]?)(?:-(\d+))?\s+(.+)$/);
  if (!m) return null;
  const words = m[3].split(" ").filter(w => !DIRS.has(w));
  let tok = words[0] || "";
  tok = ORD[tok] || tok.replace(/^(\d+)(ST|ND|RD|TH)$/, "$1");
  if (!tok || tok.length < 1) return null;
  return { num: m[1], tok };
}
// Same house number and street name? ("1 NEWARK ST" vs "25 WASHINGTON STREET" → no)
export function sameAddress(a: string | null | undefined, b: string | null | undefined) {
  const x = spillKey(a || ""), y = spillKey(b || "");
  return !!x && !!y && x.num === y.num && x.tok === y.tok;
}
async function spills(address: string, county: string | null) {
  const k = spillKey(address);
  if (!k || !county) return { matched_on: null, items: [] as any[] };
  const like = `%${k.num} %${k.tok}%`.replace(/'/g, "''");
  const rows = await getJSON(soql(NYS_SPILLS, {
    $select: "spill_number,program_facility_name,street_1,locality,spill_date,close_date,material_name,material_family,quantity,units,recovered,contributing_factor,source",
    $where: `county='${county.replace(/'/g, "''")}' and upper(street_1) like '${like}'`,
    $order: "spill_date desc", $limit: "200",
  }), 8000);
  const numRe = new RegExp(`(^|[^0-9])${k.num}(?![0-9A-Z])`);
  const tokRe = /^\d+$/.test(k.tok) ? new RegExp(`\\b${k.tok}(ST|ND|RD|TH)?\\b`) : new RegExp(`\\b${k.tok}\\b`);
  const seen = new Set<string>();
  const items = (rows || []).filter((r: any) => {
    const s = String(r.street_1 || "").toUpperCase();
    return numRe.test(s) && tokRe.test(s.replace(new RegExp(`^.*?${k.num}`), ""));
  }).filter((r: any) => !seen.has(r.spill_number + r.material_name) && seen.add(r.spill_number + r.material_name)).map((r: any) => ({
    number: r.spill_number, where: [r.street_1, r.locality].filter(Boolean).join(", "), facility: r.program_facility_name || null,
    date: iso(r.spill_date), closed: iso(r.close_date), material: r.material_name || null, family: r.material_family || null,
    quantity: r.quantity && Number(r.quantity) > 0 ? `${Number(r.quantity)} ${String(r.units || "").toLowerCase()}` : null,
    cause: r.contributing_factor || null, source: r.source || null,
  }));
  return { matched_on: `${k.num} … ${k.tok}, ${county} County`, items };
}

/* ---------------- NJDEP Known Contaminated Sites ---------------- */
async function njContaminated(lat: number, lon: number, address?: string) {
  const j = await getJSON(arcPoint(NJ_KCS, lat, lon, {
    distance: String(NEAR_M), units: "esriSRUnit_Meter", returnGeometry: "true", outSR: "4326",
    outFields: "PI_NAME,ADDRESS,PI_NUMBER,SITE_ID,STATUS,REM_LEVEL,CEA_STATUS,DN_STATUS,EC_STATUS,NPL_STATUS,STATUS_DT,MUNIC",
  }), 9000);
  return (j.features || []).map((f: any) => {
    const a = f.attributes || {}, g = f.geometry;
    const d = g ? metersBetween([lat, lon], [g.y, g.x]) : null;
    const controls = [
      a.DN_STATUS && /ongoing|active/i.test(a.DN_STATUS) ? "Deed notice (soil left in place)" : "",
      a.CEA_STATUS && /ongoing|active|established/i.test(a.CEA_STATUS) ? "Groundwater CEA (contaminated groundwater)" : "",
      a.EC_STATUS && /ongoing|active/i.test(a.EC_STATUS) ? "Engineering controls (cap / barrier)" : "",
    ].filter(Boolean);
    return {
      name: a.PI_NAME, address: a.ADDRESS || null, town: a.MUNIC || null, status: a.STATUS || null,
      status_date: iso(a.STATUS_DT), controls, npl: a.NPL_STATUS || null,
      number: a.PI_NUMBER || null, site_id: a.SITE_ID || null,
      distance_m: d, on_lot: (d != null && d <= ON_LOT_M) || sameAddress(address, a.ADDRESS),
    };
  }).sort((a: any, b: any) => (a.distance_m ?? 9e9) - (b.distance_m ?? 9e9));
}

/* ---------------- EPA Superfund (NPL) ---------------- */
const stripTags = (s: any) => String(s || "").replace(/<[^>]+>/g, "").trim();
const hrefOf = (s: any) => (String(s || "").match(/href="([^"]+)"/) || [])[1] || null;
async function superfund(lat: number, lon: number) {
  const j = await getJSON(arcPoint(EPA_NPL, lat, lon, {
    distance: String(NPL_M), units: "esriSRUnit_Meter", returnGeometry: "true", outSR: "4326",
    outFields: "Site_Name,Site_EPA_ID,Status,Listing_Date,City,Site_Progress_Profile",
  }), 9000);
  return (j.features || []).map((f: any) => {
    const a = f.attributes || {}, g = f.geometry;
    return {
      name: a.Site_Name, epa_id: a.Site_EPA_ID, status: a.Status || null, listed: a.Listing_Date || null, city: a.City || null,
      distance_m: g ? metersBetween([lat, lon], [g.y, g.x]) : null,
      url: hrefOf(a.Site_Progress_Profile) || (a.Site_EPA_ID ? `https://cumulis.epa.gov/supercpad/cursites/csitinfo.cfm?id=${encodeURIComponent(String(a.Site_EPA_ID).replace(/^\D+0*/, ""))}` : null),
      label: stripTags(a.Site_Progress_Profile) || a.Site_Name,
    };
  }).sort((a: any, b: any) => (a.distance_m ?? 9e9) - (b.distance_m ?? 9e9));
}

/* ---------------- roll-up ---------------- */
export interface EnvInput { lat: number; lon: number; region: "nyc" | "nys" | "nj"; bbl?: string; address?: string; county?: string }

export async function buildEnvironment(inp: EnvInput) {
  const { lat, lon, region } = inp;
  const bbl = inp.bbl && /^\d{10}$/.test(inp.bbl) ? inp.bbl : undefined;
  const county = region === "nyc" ? (bbl ? NYC_COUNTY[bbl[0]] : inp.county || null)
    : (inp.county ? String(inp.county).replace(/\s+County$/i, "").replace(/\b\w/g, c => c.toUpperCase()).replace(/\B\w+/g, w => w.toLowerCase()) : null);

  const tasks: Record<string, Promise<any>> = {
    flood: flood(lat, lon),
    superfund: superfund(lat, lon),
  };
  if (region === "nyc") {
    if (bbl) tasks.edesignations = eDesignations(bbl);
    tasks.oer = oerSites(lat, lon, bbl, inp.address);
  }
  if (region === "nyc" || region === "nys") {
    tasks.remediation = nysRemediation(lat, lon, inp.address);
    if (inp.address) tasks.spills = spills(inp.address, county);
  }
  if (region === "nj") tasks.nj_sites = njContaminated(lat, lon, inp.address);

  const keys = Object.keys(tasks);
  const settled = await Promise.allSettled(keys.map(k => tasks[k]));
  const out: any = { region, point: [lat, lon], radius_m: NEAR_M, superfund_radius_m: NPL_M, sources_failed: {} as Record<string, string> };
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") out[keys[i]] = s.value;
    else { out[keys[i]] = null; out.sources_failed[keys[i]] = String((s.reason && s.reason.message) || s.reason); }
  });

  // Plain-language findings, worst first. level: high | moderate | info
  const F: { level: string; title: string; detail: string }[] = [];
  const fl = out.flood;
  const eff = fl?.effective, pre = fl?.preliminary;
  const worstFlood = [eff, pre].filter(Boolean).sort((a: any, b: any) => Number(b.sfha) - Number(a.sfha) || (b.bfe_ft || 0) - (a.bfe_ft || 0))[0];
  if (worstFlood?.sfha) F.push({ level: "high", title: `Flood zone ${worstFlood.zone}${worstFlood.bfe_ft ? ` · base flood elevation ${worstFlood.bfe_ft} ft` : ""}`,
    detail: `${worstFlood.label}${pre && eff && pre.zone !== eff.zone ? ` (effective map: ${eff.zone}; preliminary map: ${pre.zone})` : ""}. Federally backed mortgages need flood insurance; new construction and substantial improvements must be built to flood-resistant standards above the design flood elevation.` });
  else if (worstFlood && worstFlood.level === "moderate") F.push({ level: "moderate", title: "0.2% annual-chance (500-year) flood area", detail: "Outside the 100-year floodplain but inside the 500-year. Insurance is optional; critical systems should still sit high." });

  const onLot = (arr: any[] | null | undefined) => (arr || []).filter((s: any) => s.on_lot);
  const ed = out.edesignations || [];
  const edHaz = ed.filter((e: any) => e.hazmat);
  if (edHaz.length) F.push({ level: "high", title: `Hazardous-materials E-designation (${edHaz.map((e: any) => e.number).join(", ")})`,
    detail: "DOB won't issue permits for new construction or a change of use until the NYC Office of Environmental Remediation signs off — expect a Phase I/II, a remedial plan and a Notice of Satisfaction before work starts." });
  const edOther = ed.filter((e: any) => !e.hazmat && (e.air || e.noise));
  if (edOther.length) F.push({ level: "moderate", title: `${edOther.some((e: any) => e.air) ? "Air quality" : ""}${edOther.some((e: any) => e.air) && edOther.some((e: any) => e.noise) ? " / " : ""}${edOther.some((e: any) => e.noise) ? "noise" : ""} E-designation (${edOther.map((e: any) => e.number).join(", ")})`,
    detail: edOther.map((e: any) => e.description).filter(Boolean).join("; ") + ". OER must approve the design (e.g. HVAC fuel / stack location, window-wall attenuation) before DOB permits." });

  const lotSites = [...onLot(out.oer), ...onLot(out.remediation), ...onLot(out.nj_sites)];
  if (lotSites.length) F.push({ level: "high", title: `Contamination case on or at this lot (${lotSites.length})`,
    detail: lotSites.map((s: any) => `${s.name}${s.program ? " — " + s.program : ""}${s.status ? " · " + s.status : ""}${s.class ? " · " + s.class : ""}`).join("; ") });
  const nearSites = [...(out.oer || []), ...(out.remediation || []), ...(out.nj_sites || [])].filter((s: any) => !s.on_lot);
  if (nearSites.length) {
    const close = nearSites.filter((s: any) => (s.distance_m ?? 9e9) <= 150).length;
    F.push({ level: close ? "moderate" : "info", title: `${nearSites.length} remediation site${nearSites.length > 1 ? "s" : ""} within ${NEAR_M} m${close ? ` (${close} within 150 m)` : ""}`,
      detail: "Neighboring contamination can migrate in groundwater or soil vapor. A Phase I ESA will list these as recognized environmental conditions if up-gradient." });
  }
  const nj = out.nj_sites || [];
  const njCtl = nj.filter((s: any) => s.controls.length && (s.on_lot || (s.distance_m ?? 9e9) <= 150));
  if (njCtl.length) F.push({ level: "moderate", title: "Deed notices / groundwater restrictions close by",
    detail: njCtl.slice(0, 4).map((s: any) => `${s.name}: ${s.controls.join(", ")}`).join("; ") });
  const sf = out.superfund || [];
  if (sf.length) F.push({ level: (sf[0].distance_m ?? 9e9) <= 400 ? "high" : (sf[0].distance_m ?? 9e9) <= 1000 ? "moderate" : "info", title: `EPA Superfund site ${sf[0].distance_m != null ? (sf[0].distance_m < 1000 ? sf[0].distance_m + " m" : (sf[0].distance_m / 1609).toFixed(1) + " mi") + " away" : "nearby"}: ${sf[0].name}`,
    detail: "Superfund proximity can bring vapor-intrusion testing, lender scrutiny and slower approvals. Check the site's plume and cleanup boundary." });
  const sp = out.spills?.items || [];
  const spOpen = sp.filter((s: any) => !s.closed);
  if (spOpen.length) F.push({ level: "high", title: `${spOpen.length} open DEC spill case${spOpen.length > 1 ? "s" : ""} at this address`,
    detail: spOpen.slice(0, 3).map((s: any) => `${s.date || "?"} — ${s.material || "unknown material"}`).join("; ") + ". An open spill must be closed by DEC before a clean Phase I." });
  const spClosed = sp.filter((s: any) => s.closed);
  const FUEL = /fuel|#2|#4|#6|heating|diesel|gasoline|kerosene|petroleum|waste oil|motor oil/i;
  const UTIL = /cable oil|transformer|dielectric|hydraulic/i;
  const fuel = spClosed.filter((s: any) => FUEL.test(s.material || "") && !UTIL.test(s.material || ""));
  if (spClosed.length) F.push({ level: fuel.length ? "moderate" : "info",
    title: `${spClosed.length} closed DEC spill record${spClosed.length > 1 ? "s" : ""} at this address${fuel.length ? ` (${fuel.length} fuel / petroleum)` : ""}`,
    detail: fuel.length
      ? "Closed, but fuel and petroleum spills usually mean a past or present heating-oil or fuel tank — ask for tank closure / removal records and check for an unregistered tank."
      : "Closed and historical (e.g. utility cable or transformer oil in the street vault). Low concern unless the Phase I says otherwise." });

  const order: Record<string, number> = { high: 0, moderate: 1, info: 2 };
  F.sort((a, b) => order[a.level] - order[b.level]);
  out.findings = F;
  out.risk = F.some(f => f.level === "high") ? "high" : F.some(f => f.level === "moderate") ? "moderate" : "low";
  out.generated_at = new Date().toISOString();
  return out;
}
