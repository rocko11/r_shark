// New Jersey property lookup.
//  1. Geocode with the State of NJ composite locator (NJOGIS, free, rooftop-level).
//  2. Find the tax parcel under that point in the statewide Parcels + MOD-IV composite.
//     OWNER_NAME is redacted statewide under Daniel's Law; the owner's MAILING address is not.
//  3. Check the daily NJ sheriff-sale capture (github.com/aimesy/njss, 17 CivilView counties).

const NJ_GEOCODE = "https://geo.nj.gov/arcgis/rest/services/Tasks/NJ_Geocode/GeocodeServer";
const NJ_PARCELS = "https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Parcels_Composite_NJ_WM/FeatureServer/0/query";
const NJSS_CSV = "https://raw.githubusercontent.com/aimesy/njss/HEAD/data/njss_sales.csv";

const PARCEL_FIELDS = "PAMS_PIN,COUNTY,MUN_NAME,PCLBLOCK,PCLLOT,PCLQCODE,PROP_LOC,PROP_CLASS,PROP_USE,BLDG_CLASS,BLDG_DESC,LAND_DESC,YR_CONSTR,DWELL,COMM_DWELL,CALC_ACRE,LAND_VAL,IMPRVT_VAL,NET_VALUE,LAST_YR_TX,SALE_PRICE,SALES_CODE,DEED_DATE,DEED_BOOK,DEED_PAGE,ST_ADDRESS,CITY_STATE,ZIP_CODE,FAC_NAME";

const PROP_CLASS_LABEL: Record<string, string> = {
  "1": "Vacant land", "2": "Residential (1–4 family)", "3A": "Farm (regular)", "3B": "Farm (qualified)",
  "4A": "Commercial", "4B": "Industrial", "4C": "Apartments (5+ units)", "5A": "Railroad (class I)", "5B": "Railroad (class II)",
  "6A": "Telephone / telecom", "6B": "Petroleum refinery",
  "15A": "Exempt — public school", "15B": "Exempt — other school", "15C": "Exempt — public property",
  "15D": "Exempt — church / charitable", "15E": "Exempt — cemetery", "15F": "Exempt — other",
};

async function getJSON(url: string, ms = 8000): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return r.json();
}

const up = (s: any) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const STREET_ABBR: [RegExp, string][] = [
  [/\bSTREET\b/g, "ST"], [/\bAVENUE\b/g, "AVE"], [/\bAV\b/g, "AVE"], [/\bBOULEVARD\b/g, "BLVD"], [/\bROAD\b/g, "RD"],
  [/\bPLACE\b/g, "PL"], [/\bDRIVE\b/g, "DR"], [/\bLANE\b/g, "LN"], [/\bTERRACE\b/g, "TER"], [/\bCOURT\b/g, "CT"],
  [/\bHIGHWAY\b/g, "HWY"], [/\bPARKWAY\b/g, "PKWY"], [/\bNORTH\b/g, "N"], [/\bSOUTH\b/g, "S"], [/\bEAST\b/g, "E"], [/\bWEST\b/g, "W"],
  [/\bFIRST\b/g, "1ST"], [/\bSECOND\b/g, "2ND"], [/\bTHIRD\b/g, "3RD"], [/\bFOURTH\b/g, "4TH"], [/\bFIFTH\b/g, "5TH"],
  [/\bSIXTH\b/g, "6TH"], [/\bSEVENTH\b/g, "7TH"], [/\bEIGHTH\b/g, "8TH"], [/\bNINTH\b/g, "9TH"], [/\bTENTH\b/g, "10TH"],
];
export function normStreet(s: string) {
  let t = up(s);
  for (const [re, v] of STREET_ABBR) t = t.replace(re, v);
  return t;
}
// "714 THIRD STREET" → { num: "714", street: "3RD ST" }
function splitAddr(s: string) {
  const t = normStreet(s);
  const m = t.match(/^(\d+[A-Z]?(?:\s*-\s*\d+)?)\s+(.*)$/);
  return m ? { num: m[1].replace(/\s/g, ""), street: m[2] } : { num: "", street: t };
}

function dateFromYYMMDD(s: any): string | null {
  const v = String(s ?? "").trim();
  if (!/^\d{6}$/.test(v)) return null;
  const yy = Number(v.slice(0, 2)), yyyy = yy > 50 ? 1900 + yy : 2000 + yy;
  return `${yyyy}-${v.slice(2, 4)}-${v.slice(4, 6)}`;
}

export async function njGeocode(address: string) {
  const qs = new URLSearchParams({ SingleLine: address, outSR: "4326", maxLocations: "5", outFields: "Match_addr,Addr_type,Score,City,Postal", f: "json" });
  const j = await getJSON(`${NJ_GEOCODE}/findAddressCandidates?${qs}`);
  return (j.candidates || [])
    .filter((c: any) => c.location && c.score >= 80)
    .map((c: any) => ({ address: c.address, score: c.score, type: c.attributes?.Addr_type, x: c.location.x, y: c.location.y }));
}

export async function njSuggest(text: string) {
  const qs = new URLSearchParams({ text, maxSuggestions: "8", f: "json" });
  const j = await getJSON(`${NJ_GEOCODE}/suggest?${qs}`, 5000);
  return (j.suggestions || []).map((s: any) => ({ label: s.text, bbl: null }));
}

// Parcel under the geocoded point; if its address doesn't match (geocoder point on a
// neighbouring lot or the street), look in a 40 m radius for the lot with the right number.
async function njParcelFor(x: number, y: number, wantAddr: string) {
  const base = { geometry: `${x},${y}`, geometryType: "esriGeometryPoint", inSR: "4326", spatialRel: "esriSpatialRelIntersects",
    outFields: PARCEL_FIELDS, returnGeometry: "true", outSR: "4326", geometryPrecision: "6", f: "json" };
  const want = splitAddr(wantAddr);
  const matches = (f: any) => {
    const got = splitAddr(f.attributes?.PROP_LOC || "");
    return !!want.num && got.num.split("-")[0] === want.num.split("-")[0] && got.street.split(" ")[0] === want.street.split(" ")[0];
  };
  const hit = await getJSON(`${NJ_PARCELS}?${new URLSearchParams(base)}`);
  const at = hit.features || [];
  if (at.some(matches)) return { feature: at.find(matches), exact: true };
  const near = await getJSON(`${NJ_PARCELS}?${new URLSearchParams({ ...base, distance: "40", units: "esriSRUnit_Meter" })}`).catch(() => ({ features: [] }));
  const nf = near.features || [];
  const m = nf.find(matches);
  if (m) return { feature: m, exact: true };
  return { feature: at[0] || null, exact: false };
}

// ── NJ sheriff sales (daily CSV, cached per function instance for 6 h) ──
let njssCache: { at: number; rows: Record<string, string>[] } | null = null;
function parseCSV(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
async function njssRows() {
  if (njssCache && Date.now() - njssCache.at < 6 * 3600_000) return njssCache.rows;
  const r = await fetch(NJSS_CSV, { signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error(`njss HTTP ${r.status}`);
  njssCache = { at: Date.now(), rows: parseCSV(await r.text()) };
  return njssCache.rows;
}
async function njSheriffSales(propLoc: string, muni: string) {
  try {
    const want = splitAddr(propLoc);
    if (!want.num) return [];
    const town = up(muni).replace(/\b(CITY|TOWN|TOWNSHIP|TWP|BOROUGH|BORO|VILLAGE)\b/g, "").trim().split(" ")[0];
    const rows = await njssRows();
    return rows.filter(r => {
      const a = normStreet(r.address || "");
      const got = splitAddr(a.split(",")[0] || "");
      return got.num.split("-")[0] === want.num.split("-")[0]
        && got.street.split(" ")[0] === want.street.split(" ")[0]
        && (!town || a.includes(town));
    }).map(r => ({
      county: r.county, sheriff_number: r.sheriff_number, docket: r.court_case_number,
      status: r.current_status, on_open_list: r.on_open_list === "True", sale_date: r.sale_date,
      plaintiff: r.plaintiff, defendant: r.defendant, address: r.address,
      judgment: Number(r.judgment_amount) || null, upset: Number(r.upset_amount) || null,
      attorney: r.attorney, attorney_phone: r.attorney_phone, first_seen: r.first_seen,
    })).sort((a, b) => String(b.sale_date).localeCompare(String(a.sale_date)));
  } catch { return null; } // null = lookup unavailable, [] = none found
}

export async function buildNJReport(address: string) {
  const cands = await njGeocode(address);
  if (!cands.length) return { found: false, region: "nj", error: "The NJ state geocoder couldn't find that address. Include the town, e.g. \"700 Newark Ave, Jersey City NJ\"." };
  const top = cands[0];
  const { feature, exact } = await njParcelFor(top.x, top.y, top.address.split(",")[0]);
  if (!feature) return { found: false, region: "nj", error: `Found ${top.address}, but no tax parcel at that point in the NJ parcel composite.` };

  const a = feature.attributes || {};
  const propLoc = String(a.PROP_LOC || "").trim();
  const mailing = [a.ST_ADDRESS, a.CITY_STATE, a.ZIP_CODE].map((s: any) => String(s ?? "").trim()).filter(Boolean).join(", ");
  const mailMatchesProp = !!a.ST_ADDRESS && splitAddr(a.ST_ADDRESS).num === splitAddr(propLoc).num
    && splitAddr(a.ST_ADDRESS).street.split(" ")[0] === splitAddr(propLoc).street.split(" ")[0];
  const outOfState = /,\s*([A-Z]{2})\b/.test(String(a.CITY_STATE || "")) && !/\bNJ\b/.test(String(a.CITY_STATE || "").toUpperCase());
  const ring = feature.geometry?.rings?.[0] || [];
  const centroid = ring.length ? [ring.reduce((s: number, p: number[]) => s + p[1], 0) / ring.length, ring.reduce((s: number, p: number[]) => s + p[0], 0) / ring.length] : [top.y, top.x];
  const cls = String(a.PROP_CLASS || "").trim().toUpperCase();
  const salePrice = Number(a.SALE_PRICE) || 0;

  return {
    found: true,
    region: "nj",
    generated_at: new Date().toISOString(),
    query: address,
    geocode: { matched: top.address, score: top.score, type: top.type, lat: top.y, lon: top.x, alternatives: cands.slice(1, 4).map((c: any) => c.address) },
    parcel_exact: exact,
    parcel: {
      pams_pin: a.PAMS_PIN, county: a.COUNTY, municipality: a.MUN_NAME, block: a.PCLBLOCK, lot: a.PCLLOT, qualifier: a.PCLQCODE || null,
      address: propLoc, property_class: cls, property_class_label: PROP_CLASS_LABEL[cls] || null, facility: a.FAC_NAME || null,
      building: a.BLDG_DESC || null, land_desc: a.LAND_DESC || null, year_built: Number(a.YR_CONSTR) || null,
      dwellings: Number(a.DWELL) || null, commercial_dwellings: Number(a.COMM_DWELL) || null,
      acres: Number(a.CALC_ACRE) || null,
      land_value: Number(a.LAND_VAL) || null, improvement_value: Number(a.IMPRVT_VAL) || null, net_value: Number(a.NET_VALUE) || null,
      last_year_tax: Number(a.LAST_YR_TX) || null,
      last_sale: { price: salePrice > 100 ? salePrice : null, nominal: salePrice > 0 && salePrice <= 100, date: dateFromYYMMDD(a.DEED_DATE), code: a.SALES_CODE || null,
        deed_book: a.DEED_BOOK || null, deed_page: a.DEED_PAGE || null },
      owner_name: null, // redacted statewide under Daniel's Law
      owner_mailing: mailing || null,
      absentee: !!a.ST_ADDRESS && !mailMatchesProp,
      out_of_state: outOfState,
    },
    geometry: { rings: feature.geometry?.rings || [], centroid },
    sheriff_sales: await njSheriffSales(propLoc, String(a.MUN_NAME || "")),
    sources: [
      { name: "NJ Geocoder (NJOGIS)", url: NJ_GEOCODE },
      { name: "Parcels & MOD-IV Composite of NJ (NJOGIS)", url: NJ_PARCELS.replace(/\/query$/, "") },
      { name: "NJ sheriff sales — daily CivilView capture (github.com/aimesy/njss)", url: "https://github.com/aimesy/njss" },
    ],
  };
}
