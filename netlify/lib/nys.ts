// New York State (outside NYC) property lookup.
//  1. Geocode with the NYS Street & Address Composite locator (ITS GIS, free).
//  2. County / city-or-town / SWIS at that point from NYS Civil Boundaries.
//     A point inside the five boroughs is handed back to the NYC report.
//  3. Parcel record: NYS Tax Parcels Public layer (38 counties share geometry + roll data),
//     merged with the ORPTS final assessment roll row (data.ny.gov 7vem-aaz7) for class
//     descriptions, all owners, exemptions and deed. Counties without shared parcel maps
//     (e.g. Nassau, Monroe, Dutchess) fall back to the assessment roll alone.

import { addrMatch, normStreet, streetCore } from "./nj.ts";
import { townTail, NYC_PLACE_RE } from "./region.ts";

const NYS_GEOCODE = "https://gisservices.its.ny.gov/arcgis/rest/services/Locators/Street_and_Address_Composite/GeocodeServer/findAddressCandidates";
const NYS_TOWNS = "https://gisservices.its.ny.gov/arcgis/rest/services/NYS_Civil_Boundaries/FeatureServer/6/query";
const NYS_PARCELS = "https://services6.arcgis.com/EbVsqZ18sv1kVJ3k/arcgis/rest/services/NYS_Tax_Parcels_Public/FeatureServer/1/query";
const NYS_ROLLS = "https://data.ny.gov/resource/7vem-aaz7.json";
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN;

export const NYC_COUNTIES = new Set(["New York", "Kings", "Queens", "Bronx", "Richmond"]);

const PARCEL_FIELDS = [
  "COUNTY_NAME", "MUNI_NAME", "CITYTOWN_NAME", "SWIS", "PRINT_KEY", "SBL", "PARCEL_ADDR", "LOC_ZIP", "PROP_CLASS", "ROLL_SECTION",
  "LAND_AV", "TOTAL_AV", "FULL_MARKET_VAL", "YR_BLT", "FRONT", "DEPTH", "SQ_FT", "ACRES", "CALC_ACRES", "SCHOOL_NAME",
  "SEWER_DESC", "WATER_DESC", "UTILITIES_DESC", "BLDG_STYLE_DESC", "HEAT_TYPE_DESC", "FUEL_TYPE_DESC", "SQFT_LIVING",
  "NBR_KITCHENS", "NBR_FULL_BATHS", "NBR_BEDROOMS", "USED_AS_DESC", "AG_DIST_NAME", "PRIMARY_OWNER", "MAIL_ADDR", "PO_BOX",
  "MAIL_CITY", "MAIL_STATE", "MAIL_ZIP", "ADD_OWNER", "BOOK", "PAGE", "ROLL_YR", "OWNER_TYPE",
].join(",");

async function getJSON(url: string, ms = 8000): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: url.startsWith(NYS_ROLLS) && APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {} });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return r.json();
}
const clean = (v: any) => String(v ?? "").replace(/\s+/g, " ").trim();
const title = (s: string) => clean(s).toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
const num = (v: any) => (Number(v) > 0 ? Number(v) : null);

async function nysGeocode(address: string, max = 3) {
  const qs = new URLSearchParams({ SingleLine: address, outSR: "4326", maxLocations: String(max), outFields: "City,Addr_type,Score", f: "json" });
  const j = await getJSON(`${NYS_GEOCODE}?${qs}`);
  return (j.candidates || []).filter((c: any) => c.location && c.score >= 85)
    .map((c: any) => ({ address: c.address, score: c.score, type: c.attributes?.Addr_type, city: c.attributes?.City, x: c.location.x, y: c.location.y }));
}

async function townAt(x: number, y: number) {
  const j = await getJSON(`${NYS_TOWNS}?${new URLSearchParams({ geometry: `${x},${y}`, geometryType: "esriGeometryPoint", inSR: "4326",
    spatialRel: "esriSpatialRelIntersects", outFields: "NAME,MUNI_TYPE,COUNTY,SWIS", returnGeometry: "false", f: "json" })}`, 6000);
  const a = j.features?.[0]?.attributes;
  return a ? { name: clean(a.NAME), type: clean(a.MUNI_TYPE), county: clean(a.COUNTY), swis: clean(a.SWIS) } : null;
}

// Decide NYC vs rest-of-state for an ambiguous address. Returns null if it can't be geocoded.
// A typed upstate town that the geocoder "matched" to an NYC street is rejected, so
// "135 Woodlawn Ave, Saratoga Springs, Inside" never becomes 135 Woodlawn Ave, Staten Island.
function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}


const NYS_BOUNDS = "https://gisservices.its.ny.gov/arcgis/rest/services/NYS_Civil_Boundaries/FeatureServer";
let placeCache: { at: number; names: string[] } | null = null;
async function placeNames(): Promise<string[]> {
  if (placeCache && Date.now() - placeCache.at < 24 * 3600_000) return placeCache.names;
  const names = new Set<string>();
  for (const layer of [6, 7]) {
    const j = await getJSON(`${NYS_BOUNDS}/${layer}/query?${new URLSearchParams({ where: "1=1", outFields: "NAME", returnGeometry: "false", resultRecordCount: "2000", f: "json" })}`, 6000).catch(() => ({ features: [] }));
    (j.features || []).forEach((f: any) => f.attributes?.NAME && names.add(String(f.attributes.NAME)));
  }
  placeCache = { at: Date.now(), names: [...names] };
  return placeCache.names;
}
async function closestPlace(typed: string): Promise<string | null> {
  const t = typed.toUpperCase().replace(/[^A-Z]/g, "");
  if (t.length < 4) return null;
  let best: string | null = null, bestD = 99;
  for (const n of await placeNames()) {
    const s = n.toUpperCase().replace(/[^A-Z]/g, "");
    if (s === t) return null; // already a real place name — nothing to fix
    if (Math.min(s.length, t.length) < 5 || Math.abs(s.length - t.length) > 2) continue;
    const d = lev(s, t);
    if (d < bestD) { bestD = d; best = n; }
  }
  return bestD <= 2 ? best : null;
}

export async function nysWhere(address: string) {
  let cands = await nysGeocode(address).catch(() => []);
  const tail = townTail(address);
  if (!cands.length && tail) {
    // Town misspelled / split ("south hampton", "new rochel"): swap in the closest official
    // city / town / village name and geocode again (the locator needs a valid town or ZIP).
    const fixed = await closestPlace(tail);
    if (fixed) {
      const street = address.split(",")[0].replace(new RegExp("\\s" + tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ".*$", "i"), "").trim();
      cands = await nysGeocode(`${street}, ${fixed}, NY`).catch(() => []);
    }
  }
  if (!cands.length) return null;
  const typedNYC = !tail || NYC_PLACE_RE.test(` ${tail} `) || /\bNEW YORK\b/.test(tail);
  for (const cand of cands.slice(0, 3)) {
    const town = await townAt(cand.x, cand.y).catch(() => null);
    const inNYC = !!town && NYC_COUNTIES.has(town.county);
    if (inNYC && !typedNYC) continue;          // upstate town typed, NYC point returned → not a match
    return { cand, cands, town, inNYC };
  }
  return null;
}

async function parcelAt(x: number, y: number, want: string[]) {
  const base = { geometry: `${x},${y}`, geometryType: "esriGeometryPoint", inSR: "4326", spatialRel: "esriSpatialRelIntersects",
    outFields: PARCEL_FIELDS, returnGeometry: "true", outSR: "4326", geometryPrecision: "6", f: "json" };
  const matches = (f: any) => want.some(w => addrMatch(f.attributes?.PARCEL_ADDR || "", w));
  const at = (await getJSON(`${NYS_PARCELS}?${new URLSearchParams(base)}`).catch(() => ({ features: [] }))).features || [];
  if (at.some(matches)) return { f: at.find(matches), exact: true };
  const near = (await getJSON(`${NYS_PARCELS}?${new URLSearchParams({ ...base, distance: "40", units: "esriSRUnit_Meter" })}`).catch(() => ({ features: [] }))).features || [];
  const m = near.find(matches);
  if (m) return { f: m, exact: true };
  return { f: at[0] || null, exact: false };
}

let rollYear: { y: number; at: number } | null = null;
async function latestRollYear() {
  if (rollYear && Date.now() - rollYear.at < 6 * 3600_000) return rollYear.y;
  const y = Number((await getJSON(`${NYS_ROLLS}?$select=max(roll_year) as y`, 5000).catch(() => [{}]))?.[0]?.y) || 2025;
  rollYear = { y, at: Date.now() };
  return y;
}
const ROLL_SELECT = "county_name,municipality_name,swis_code,print_key_code,school_district_name,property_class,property_class_description,roll_section,"
  + "parcel_address_number,parcel_address_street,parcel_address_suff,front,depth,deed_book,page,"
  + "primary_owner_first_name,primary_owner_mi,primary_owner_last_name,primary_owner_suffix,additional_owner_1_first,additional_owner_1_last_name,"
  + "additional_owner_2_first,additional_owner_2_last_name,mailing_address_prefix,mailing_address_number,mailing_address_street,mailing_address_suff,"
  + "mailing_address_city,mailing_address_state,mailing_address_zip,mailing_address_po_box,full_market_value,assessment_land,assessment_total,"
  + "exemption_code_1,exemption_code_2,exemption_code_3,exemption_code_4,grid_coordinates_east,grid_coordinates_north";
const esc = (s: string) => s.replace(/'/g, "''");

async function rollRow(swis: string, printKey: string) {
  const y = await latestRollYear();
  const j = await getJSON(`${NYS_ROLLS}?${new URLSearchParams({ $select: ROLL_SELECT, $where: `roll_year=${y} AND swis_code='${esc(swis)}' AND print_key_code='${esc(printKey)}'`, $limit: "1" })}`, 6000).catch(() => []);
  return j[0] || null;
}
// Assessment-roll search by town code + street; returns the matching row or nearby numbers.
async function rollByAddress(swis4: string, address: string) {
  const y = await latestRollYear();
  const m = normStreet(address.split(",")[0]).match(/^(\d+[A-Z]?(?:-\d+[A-Z]?)?)\s+(.+)$/);
  if (!m) return { row: null, suggestions: [] as string[] };
  const core = streetCore(m[2]);
  const j = await getJSON(`${NYS_ROLLS}?${new URLSearchParams({ $select: ROLL_SELECT,
    $where: `roll_year=${y} AND starts_with(swis_code,'${esc(swis4)}') AND upper(parcel_address_street) like '%${esc(core)}%'`, $limit: "3000" })}`, 8000).catch(() => []);
  const addrOf = (r: any) => clean(`${r.parcel_address_number || ""} ${r.parcel_address_street || ""} ${r.parcel_address_suff || ""}`);
  const row = j.find((r: any) => addrMatch(addrOf(r), address.split(",")[0]));
  if (row) return { row, suggestions: [] };
  const target = Number(m[1].split("-")[0].replace(/\D/g, "")) || 0;
  const seen = new Set<string>();
  const suggestions = j.filter((r: any) => r.parcel_address_number && addrMatch(`${r.parcel_address_number} ${m[2]}`, addrOf(r)))
    .map((r: any) => ({ a: addrOf(r), n: Number(String(r.parcel_address_number).replace(/\D.*$/, "")) || 0, town: title(r.municipality_name) }))
    .filter((s: any) => !seen.has(s.a) && seen.add(s.a))
    .sort((p: any, q: any) => Math.abs(p.n - target) - Math.abs(q.n - target)).slice(0, 6)
    .map((s: any) => `${s.a}, ${s.town}, NY`);
  return { row: null, suggestions };
}

function mailingFromRoll(r: any) {
  const street = clean([r.mailing_address_prefix, r.mailing_address_number, r.mailing_address_street, r.mailing_address_suff].join(" "))
    || (r.mailing_address_po_box ? `PO Box ${clean(r.mailing_address_po_box)}` : "");
  return [street, [r.mailing_address_city, r.mailing_address_state].map(clean).filter(Boolean).join(", "), clean(r.mailing_address_zip)].filter(Boolean).join(", ");
}
const ownersFromRoll = (r: any) => [
  clean([r.primary_owner_first_name, r.primary_owner_mi, r.primary_owner_last_name, r.primary_owner_suffix].join(" ")),
  clean([r.additional_owner_1_first, r.additional_owner_1_last_name].join(" ")),
  clean([r.additional_owner_2_first, r.additional_owner_2_last_name].join(" ")),
].filter(Boolean);

export async function buildNYSReport(address: string, where?: Awaited<ReturnType<typeof nysWhere>>) {
  const w = where || await nysWhere(address);
  if (!w) return { found: false, region: "nys", error: "Couldn't find that address in New York State. Check the house number and include the town, e.g. \"399 Park Hill Ave, Yonkers NY\"." };
  if (w.inNYC) return { found: false, region: "nyc_redirect" };
  const c = w.cand, town = w.town;
  const inputStreet = address.split(",")[0];
  const want = [c.address.split(",")[0], inputStreet];

  const pm = await parcelAt(c.x, c.y, want);
  let layer = pm.f?.attributes || null;
  let exact = pm.exact;
  let roll: any = null;
  let suggestions: string[] = [];
  let source = "";

  if (layer && exact) {
    roll = await rollRow(clean(layer.SWIS), clean(layer.PRINT_KEY));
    source = "NYS tax parcel map + assessment roll";
  } else if (town?.swis) {
    // Not in the parcel map (county doesn't share it) or the point missed: search the assessment roll.
    const r = await rollByAddress(town.swis.slice(0, 4), inputStreet).catch(() => ({ row: null, suggestions: [] as string[] }));
    if (!r.row && c.address.split(",")[0] !== inputStreet) {
      const r2 = await rollByAddress(town.swis.slice(0, 4), c.address.split(",")[0]).catch(() => ({ row: null, suggestions: [] as string[] }));
      if (r2.row) Object.assign(r, r2);
    }
    if (r.row) { roll = r.row; exact = true; source = layer ? "NYS assessment roll (parcel map shows a neighbouring lot)" : "NYS assessment roll"; if (layer) layer = null; }
    else suggestions = r.suggestions;
    if (!roll && layer) source = "NYS tax parcel map (closest lot)";
  }
  if (!layer && !roll) {
    return { found: false, region: "nys", suggestions,
      error: suggestions.length
        ? `No tax parcel is recorded at that address in ${town?.name || "that town"}. Nearest numbers on that street: ${suggestions.map(s => s.split(",")[0]).join(", ")}.`
        : `Found ${c.address}, but no matching parcel in the ${town?.county || ""} County assessment roll.` };
  }

  const ring = pm.f && layer ? (pm.f.geometry?.rings?.[0] || []) : [];
  const centroid = ring.length ? [ring.reduce((s: number, p: number[]) => s + p[1], 0) / ring.length, ring.reduce((s: number, p: number[]) => s + p[0], 0) / ring.length] : [c.y, c.x];
  const L = layer || {}, R = roll || {};
  const propAddr = clean(L.PARCEL_ADDR) || clean(`${R.parcel_address_number || ""} ${R.parcel_address_street || ""} ${R.parcel_address_suff || ""}`);
  const owners = roll ? ownersFromRoll(R) : [clean(L.PRIMARY_OWNER), clean(L.ADD_OWNER)].filter(Boolean);
  const mailing = roll ? mailingFromRoll(R) : [clean(L.MAIL_ADDR) || (L.PO_BOX ? `PO Box ${clean(L.PO_BOX)}` : ""), [clean(L.MAIL_CITY), clean(L.MAIL_STATE)].filter(Boolean).join(", "), clean(L.MAIL_ZIP)].filter(Boolean).join(", ");
  const mailStreet = roll ? clean(`${R.mailing_address_number || ""} ${R.mailing_address_street || ""} ${R.mailing_address_suff || ""}`) : clean(L.MAIL_ADDR);
  const mailState = clean(roll ? R.mailing_address_state : L.MAIL_STATE).toUpperCase();
  const absentee = !!mailStreet && !addrMatch(mailStreet, propAddr);
  const acres = num(L.ACRES) || num(L.CALC_ACRES) || (num(R.front) && num(R.depth) ? (Number(R.front) * Number(R.depth)) / 43560 : null);
  const fmv = num(R.full_market_value) || num(L.FULL_MARKET_VAL);
  const cls = clean(R.property_class || L.PROP_CLASS);

  return {
    found: true,
    region: "nys",
    generated_at: new Date().toISOString(),
    query: address,
    source,
    geocode: { matched: c.address, score: c.score, lat: c.y, lon: c.x, alternatives: w.cands.slice(1).map((x: any) => x.address) },
    parcel_exact: exact,
    suggestions,
    parcel: {
      address: propAddr,
      zip: clean(L.LOC_ZIP) || null,
      county: clean(L.COUNTY_NAME || R.county_name || town?.county),
      municipality: clean(L.MUNI_NAME || R.municipality_name || town?.name),
      city_town: clean(L.CITYTOWN_NAME || town?.name),
      swis: clean(L.SWIS || R.swis_code), print_key: clean(L.PRINT_KEY || R.print_key_code), sbl: clean(L.SBL) || null,
      property_class: cls, property_class_label: clean(R.property_class_description) || null,
      roll_section: clean(R.roll_section || L.ROLL_SECTION) || null,
      owners, owner_type: clean(L.OWNER_TYPE) || null, owner_mailing: mailing || null,
      absentee, out_of_state: !!mailState && mailState !== "NY",
      market_value: fmv, assessed_total: num(R.assessment_total) || num(L.TOTAL_AV), assessed_land: num(R.assessment_land) || num(L.LAND_AV),
      acres, lot_sf: acres ? Math.round(acres * 43560) : null,
      acres_source: num(L.ACRES) ? "assessor acreage" : num(L.CALC_ACRES) ? "parcel map" : acres ? "frontage × depth" : null,
      frontage: num(R.front) || num(L.FRONT), depth: num(R.depth) || num(L.DEPTH),
      year_built: num(L.YR_BLT), living_sf: num(L.SQFT_LIVING), building_style: clean(L.BLDG_STYLE_DESC) || null,
      bedrooms: num(L.NBR_BEDROOMS), full_baths: num(L.NBR_FULL_BATHS), kitchens: num(L.NBR_KITCHENS),
      heat: clean(L.HEAT_TYPE_DESC) || null, fuel: clean(L.FUEL_TYPE_DESC) || null,
      water: clean(L.WATER_DESC) || null, sewer: clean(L.SEWER_DESC) || null, utilities: clean(L.UTILITIES_DESC) || null,
      used_as: clean(L.USED_AS_DESC) || null, ag_district: clean(L.AG_DIST_NAME) || null,
      school_district: clean(R.school_district_name || L.SCHOOL_NAME) || null,
      deed: R.deed_book ? `Book ${clean(R.deed_book)}${R.page ? ", page " + clean(R.page) : ""}` : (L.BOOK ? `Book ${clean(L.BOOK)}${L.PAGE ? ", page " + clean(L.PAGE) : ""}` : null),
      exemptions: [R.exemption_code_1, R.exemption_code_2, R.exemption_code_3, R.exemption_code_4].map(clean).filter(Boolean),
      roll_year: Number(L.ROLL_YR) || (roll ? await latestRollYear() : null),
    },
    geometry: { rings: layer && pm.f ? (pm.f.geometry?.rings || []) : [], centroid },
    sources: [
      { name: "NYS Street & Address geocoder (ITS GIS)", url: NYS_GEOCODE.replace(/\/findAddressCandidates$/, "") },
      { name: "NYS Tax Parcels Public (38 counties)", url: NYS_PARCELS.replace(/\/query$/, "") },
      { name: "NYS final assessment rolls (ORPTS, data.ny.gov)", url: "https://data.ny.gov/d/7vem-aaz7" },
    ],
  };
}
