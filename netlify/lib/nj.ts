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

const up = (s: any) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9 \-]/g, " ").replace(/\s*-\s*/g, "-").replace(/\s+/g, " ").trim();
const STREET_ABBR: [RegExp, string][] = [
  [/\bSTREET\b/g, "ST"], [/\bAVENUE\b/g, "AVE"], [/\bAV\b/g, "AVE"], [/\bBOULEVARD\b/g, "BLVD"], [/\bROAD\b/g, "RD"],
  [/\bPLACE\b/g, "PL"], [/\bTERR\b/g, "TER"], [/\bPLAZA\b/g, "PLZ"], [/\bCIRCLE\b/g, "CIR"], [/\bTURNPIKE\b/g, "TPKE"],
  [/\bSQUARE\b/g, "SQ"], [/\bEXTENSION\b/g, "EXT"], [/\bTRAIL\b/g, "TRL"], [/\bCRESCENT\b/g, "CRES"], [/\bSAINT\b/g, "ST"], [/\bMOUNT\b/g, "MT"], [/\bDRIVE\b/g, "DR"], [/\bLANE\b/g, "LN"], [/\bTERRACE\b/g, "TER"], [/\bCOURT\b/g, "CT"],
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
const stripUnit = (s: string) => String(s || "").replace(/\s*(#\s*\S+|\b(APT|APARTMENT|UNIT|STE|SUITE|FL|FLOOR)\b\.?\s*\S+)\s*$/i, "").replace(/\s*(#\s*\S+|\b(APT|APARTMENT|UNIT|STE|SUITE)\b\.?\s*\S+)(?=\s*,)/i, "");
function splitAddr(s: string) {
  const t = normStreet(stripUnit(s));
  const m = t.match(/^(\d+[A-Z]?(?:\s*-\s*\d+[A-Z]?)?)\s+(.*)$/);
  return m ? { num: m[1].replace(/\s/g, ""), street: m[2] } : { num: "", street: t };
}
// "106-108" → [106,108]; "108A" → [108,108]
export function numRange(n: string): [number, number] | null {
  const m = String(n || "").match(/^(\d+)[A-Z]?(?:-(\d+)[A-Z]?)?$/);
  if (!m) return null;
  const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
  // "1-3" style where 2nd part is shorter ("106-8") → expand to 108
  const bb = m[2] && m[2].length < m[1].length ? Number(m[1].slice(0, m[1].length - m[2].length) + m[2]) : b;
  return [Math.min(a, bb), Math.max(a, bb)];
}
const STREET_TYPES = new Set(["ST", "AVE", "RD", "BLVD", "PL", "DR", "LN", "TER", "CT", "HWY", "PKWY", "WAY", "PLZ", "PLAZA", "SQ", "CIR", "TPKE", "PIKE", "ROUTE", "RT", "EXT", "ALY", "ROW", "WALK", "PATH", "XING", "TRL", "LOOP"]);
// Core street name: drop directionals, type words, "JR", single-letter initials ("J F KENNEDY" → "KENNEDY").
function coreTokens(street: string): string[] {
  const toks = normStreet(street).replace(/#.*$/, "").split(" ").filter(Boolean);
  // keep a type word that IS the name ("AVENUE A" → A, "ST" in "ST JAMES" is SAINT)
  const core = toks.filter((t, i) => !(STREET_TYPES.has(t) && i > 0 && i === toks.length - 1) && !(STREET_TYPES.has(t) && i > 0 && i < toks.length - 1 && t !== "ST")
    && !(["N", "S", "E", "W", "JR", "SR"].includes(t) && toks.length > 1) && !(t.length === 1 && i < toks.length - 1 && /[A-Z]/.test(t)));
  return core.length ? core : toks.slice(0, 1);
}
// Last word of the name — used for the SQL LIKE prefilter.
export function streetCore(street: string): string {
  const c = coreTokens(street);
  return c[c.length - 1] || "";
}
// Names compared with spaces removed; one may end with the other ("JOHN F KENNEDY" ~ "KENNEDY").
function sameStreet(a: string, b: string): boolean {
  const x = coreTokens(a).join(""), y = coreTokens(b).join("");
  if (!x || !y) return false;
  if (x === y) return true;
  const [s, l] = x.length < y.length ? [x, y] : [y, x];
  return s.length >= 5 && l.endsWith(s);
}
export function addrMatch(a: string, b: string): boolean {
  const A = splitAddr(a), B = splitAddr(b);
  const ra = numRange(A.num), rb = numRange(B.num);
  if (!ra || !rb) return false;
  return ra[0] <= rb[1] && rb[0] <= ra[1] && sameStreet(A.street, B.street);
}
// Collapse doubled street types the user typed ("newark avenue street" → "newark avenue")
// and split "A/K/A" aliases into separate addresses to try.
export function inputVariants(address: string): string[] {
  const cleaned = address.replace(/\b(avenue|ave|street|st|road|rd|boulevard|blvd|place|pl|drive|dr|lane|ln)\.?\s+(street|st|avenue|ave|road|rd)\b\.?/ig, "$1");
  const parts = cleaned.split(/\s+a\/?k\/?a\s+/i).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return [cleaned];
  // carry the town/state tail of the last alias ("BAYONNE NJ 07002") onto the earlier ones
  const last = parts[parts.length - 1];
  const words = last.split(/\s+/);
  let cut = -1;
  words.forEach((w, i) => { if (STREET_TYPES.has(normStreet(w))) cut = i; });
  const tail = cut >= 0 ? words.slice(cut + 1).join(" ").replace(/^,\s*/, "") : "";
  return parts.map((p, i) => (i < parts.length - 1 && tail && !/\b(NJ|New Jersey)\b/i.test(p) ? `${p}, ${tail}` : p));
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
    .map((c: any) => ({ address: c.address, score: c.score, type: c.attributes?.Addr_type, city: c.attributes?.City, x: c.location.x, y: c.location.y }));
}

export async function njSuggest(text: string) {
  const qs = new URLSearchParams({ text, maxSuggestions: "8", f: "json" });
  const j = await getJSON(`${NJ_GEOCODE}/suggest?${qs}`, 5000);
  return (j.suggestions || []).map((s: any) => ({ label: s.text, bbl: null }));
}

// ── municipality names (565) — cached; used to find the town in free text ──
let muniCache: { at: number; names: string[] } | null = null;
// "JERSEY CITY CITY" → "JERSEY CITY"; "SECAUCUS TOWN" → "SECAUCUS" (only the trailing type word)
const muniBase = (m: string) => up(m).replace(/\s+(CITY|TOWN|TOWNSHIP|TWP|BOROUGH|BORO|VILLAGE)$/, "").trim();
// Also accept the name without a trailing CITY/TOWN ("Ventnor" for "VENTNOR CITY CITY")
const muniAlt = (m: string) => muniBase(m).replace(/\s+(CITY|TOWN|TOWNSHIP|TWP|BOROUGH|BORO|VILLAGE)$/, "").trim();
async function njMunis(): Promise<string[]> {
  if (muniCache && Date.now() - muniCache.at < 24 * 3600_000) return muniCache.names;
  const j = await getJSON(`${NJ_PARCELS}?${new URLSearchParams({ where: "1=1", outFields: "MUN_NAME", returnDistinctValues: "true", returnGeometry: "false", resultRecordCount: "2000", f: "json" })}`, 9000);
  const names = (j.features || []).map((f: any) => String(f.attributes.MUN_NAME || "")).filter(Boolean);
  muniCache = { at: Date.now(), names };
  return names;
}
// Town part of the input = text after the first comma, or after the first street-type word.
async function njTownsIn(address: string, geocodedCity?: string): Promise<string[]> {
  const names = await njMunis().catch(() => [] as string[]);
  const a = up(address);
  let tail = a.includes(",") ? a.slice(a.indexOf(",")) : "";
  if (!tail) { const m = normStreet(address).match(/\b(ST|AVE|RD|BLVD|PL|DR|LN|TER|CT|HWY|PKWY|WAY)\b(.*)$/); tail = m ? m[2] : a; }
  const hay = ` ${tail} ${up(geocodedCity || "")} `.replace(/\bNEW JERSEY\b/g, " ");
  let best = 0; let hits: string[] = [];
  for (const n of names) {
    for (const b of [...new Set([muniBase(n), muniAlt(n)])]) {
      if (!b || !new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(hay)) continue;
      if (b.length > best) { best = b.length; hits = [n]; } else if (b.length === best && !hits.includes(n)) hits.push(n);
    }
  }
  return hits;
}

// "22 grove street jersey city NJ" → "22 grove street" (cut at comma, else after the first street-type word)
export function streetPart(v: string): string {
  let t = v.split(",")[0].replace(/\s+(NJ|NEW JERSEY)\b.*$/i, "").replace(/\s*(#\s*\S+|\b(APT|APARTMENT|UNIT|STE|SUITE)\b\.?\s*\S+)/i, "").trim();
  const words = t.split(/\s+/);
  const i = words.findIndex((w, k) => k > 1 && STREET_TYPES.has(normStreet(w)));
  if (i >= 0) t = words.slice(0, i + 1).join(" ");
  return t;
}
// Text search of the parcel composite: every lot on that street in that town, matched in code
// (handles "106-108 N 6TH ST" for "108 North Sixth St"). Also returns nearest house numbers.
async function njParcelByText(addr: string, towns: string[]) {
  const want = splitAddr(addr);
  const core = streetCore(want.street);
  if (!towns.length || !core || core.length < 2) return { feature: null, suggestions: [] as string[] };
  const where = `MUN_NAME IN (${towns.map(t => `'${t.replace(/'/g, "''")}'`).join(",")}) AND PROP_LOC LIKE '%${core.replace(/'/g, "''")}%'`;
  const j = await getJSON(`${NJ_PARCELS}?${new URLSearchParams({ where, outFields: PARCEL_FIELDS, returnGeometry: "true", outSR: "4326", geometryPrecision: "6", resultRecordCount: "2000", f: "json" })}`, 9000);
  const onStreet = (j.features || []).filter((f: any) => sameStreet(splitAddr(f.attributes?.PROP_LOC || "").street, want.street));
  const hit = onStreet.find((f: any) => addrMatch(f.attributes.PROP_LOC, addr));
  if (hit) return { feature: hit, suggestions: [] };
  const target = numRange(want.num)?.[0] ?? 0;
  const seen = new Set<string>();
  const suggestions = onStreet
    .map((f: any) => ({ loc: String(f.attributes.PROP_LOC).replace(/\.$/, ""), muni: f.attributes.MUN_NAME, n: numRange(splitAddr(f.attributes.PROP_LOC).num)?.[0] }))
    .filter((x: any) => x.n != null && !seen.has(x.loc) && seen.add(x.loc))
    .sort((a: any, b: any) => Math.abs(a.n - target) - Math.abs(b.n - target))
    .slice(0, 6)
    .map((x: any) => `${x.loc}, ${titleMuni(x.muni)}, NJ`);
  return { feature: null, suggestions };
}
const titleMuni = (m: string) => muniBase(m).toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());

// Parcel at the geocoded point. If none matches the address (point on the street or a
// neighbouring lot), search 40 m around it; failing a match, take the nearest lot (flagged).
async function njParcelFor(x: number, y: number, wantAddrs: string[]) {
  const base = { geometry: `${x},${y}`, geometryType: "esriGeometryPoint", inSR: "4326", spatialRel: "esriSpatialRelIntersects",
    outFields: PARCEL_FIELDS, returnGeometry: "true", outSR: "4326", geometryPrecision: "6", f: "json" };
  const matches = (f: any) => wantAddrs.some(w => addrMatch(f.attributes?.PROP_LOC || "", w));
  const at = (await getJSON(`${NJ_PARCELS}?${new URLSearchParams(base)}`)).features || [];
  if (at.some(matches)) return { feature: at.find(matches), exact: true };
  const nf = (await getJSON(`${NJ_PARCELS}?${new URLSearchParams({ ...base, distance: "40", units: "esriSRUnit_Meter" })}`).catch(() => ({ features: [] }))).features || [];
  const m = nf.find(matches);
  if (m) return { feature: m, exact: true };
  if (at[0]) return { feature: at[0], exact: false };
  const cen = (f: any) => { const r = f.geometry?.rings?.[0] || []; return r.length ? [r.reduce((s: number, p: number[]) => s + p[0], 0) / r.length, r.reduce((s: number, p: number[]) => s + p[1], 0) / r.length] : [x, y]; };
  const nearest = nf.map((f: any) => { const c = cen(f); return { f, d: (c[0] - x) ** 2 + (c[1] - y) ** 2 }; }).sort((a: any, b: any) => a.d - b.d)[0];
  return { feature: nearest?.f || null, exact: false };
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
async function njSheriffSales(addrs: string[], muni: string, zip?: string) {
  try {
    const wants = addrs.filter(a => splitAddr(a).num);
    if (!wants.length) return [];
    const town = muniAlt(muni);
    const rows = await njssRows();
    return rows.filter(r => {
      const full = up(r.address || "").replace(/\bNEW JERSEY\b/g, " ");
      const aliases = String(r.address || "").split(/\s+A\/?K\/?A\s+/i).map(s => streetPart(s));
      const sameTown = (!!town && full.includes(town)) || (!!zip && full.includes(zip));
      return sameTown && aliases.some(al => wants.some(w => addrMatch(al, w)));
    }).map(r => ({
      county: r.county, sheriff_number: r.sheriff_number, docket: r.court_case_number,
      status: r.current_status, on_open_list: r.on_open_list === "True", sale_date: r.sale_date,
      plaintiff: r.plaintiff, defendant: r.defendant, address: r.address,
      judgment: Number(r.judgment_amount) || null, upset: Number(r.upset_amount) || null,
      attorney: r.attorney, attorney_phone: r.attorney_phone, first_seen: r.first_seen,
    })).sort((a, b) => String(b.sale_date).localeCompare(String(a.sale_date)));
  } catch { return null; } // null = lookup unavailable, [] = none found
}

// Area of a lon/lat polygon in m² (local equirectangular projection; <0.5% error at lot scale).
function ringsAreaM2(rings: number[][][]): number {
  if (!rings.length) return 0;
  const lat0 = rings[0][0]?.[1] || 40, kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  let total = 0;
  for (const r of rings) {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] * kx) * (r[i][1] * ky) - (r[i][0] * kx) * (r[j][1] * ky);
    total += a / 2; // ArcGIS: outer rings clockwise (negative here), holes counter-clockwise
  }
  return Math.abs(total);
}

// Report for the parcel under a map click.
export async function buildNJReportAt(lat: number, lon: number) {
  return buildNJReport("", { lat, lon });
}

export async function buildNJReport(address: string, at?: { lat: number; lon: number }) {
  const variants = at ? [] : inputVariants(address);
  let top: any = null, feature: any = null, exact = false, via = at ? "map" : "geocoder";
  let suggestions: string[] = [];
  const geos: any[] = [];

  if (at) {
    const r = await njParcelFor(at.lon, at.lat, []);
    feature = r.feature; exact = !!r.feature;
    if (!feature) return { found: false, region: "nj", error: "No New Jersey tax parcel at that spot on the map." };
  }

  // 1. State geocoder (point addresses) → parcel at/near that point
  for (const v of variants) {
    const cands = await njGeocode(v).catch(() => []);
    if (!cands.length) continue;
    geos.push(...cands);
    const c = cands[0];
    const r = await njParcelFor(c.x, c.y, [c.address.split(",")[0], streetPart(v)]);
    if (r.feature && (r.exact || !feature)) { top = c; feature = r.feature; exact = r.exact; }
    if (exact) break;
  }
  // 2. Not exact → search the parcel records themselves by street + town
  if (!exact && !at) {
    for (const v of variants) {
      const towns = await njTownsIn(v, geos[0]?.city);
      const t = await njParcelByText(streetPart(v), towns).catch(() => ({ feature: null, suggestions: [] as string[] }));
      if (t.feature) { feature = t.feature; exact = true; via = "parcel records"; break; }
      if (!suggestions.length) suggestions = t.suggestions;
    }
  }
  if (!feature) {
    const known = !!geos.length;
    return {
      found: false, region: "nj", suggestions,
      error: suggestions.length
        ? `No tax parcel is recorded at that address. Nearest numbers on that street: ${suggestions.map(s => s.split(",")[0]).join(", ")}.`
        : known
          ? `Found ${geos[0].address}, but no tax parcel at that point in the NJ parcel records.`
          : "Couldn't find that address in New Jersey. Check the house number and include the town, e.g. \"121 Newark Ave, Jersey City NJ\".",
    };
  }
  if (!top) {
    const ring = feature.geometry?.rings?.[0] || [];
    const cx = ring.length ? ring.reduce((s: number, p: number[]) => s + p[0], 0) / ring.length : 0;
    const cy = ring.length ? ring.reduce((s: number, p: number[]) => s + p[1], 0) / ring.length : 0;
    top = { address: `${feature.attributes.PROP_LOC}, ${titleMuni(feature.attributes.MUN_NAME)}, NJ`, score: 100, type: "ParcelRecord", x: cx, y: cy };
  }

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
    geocode: { matched: top.address, score: top.score, type: top.type, lat: top.y, lon: top.x, via, alternatives: geos.slice(1, 4).map((c: any) => c.address) },
    parcel_exact: exact,
    suggestions: exact ? [] : suggestions,
    parcel: {
      pams_pin: a.PAMS_PIN, county: a.COUNTY, municipality: a.MUN_NAME, block: a.PCLBLOCK, lot: a.PCLLOT, qualifier: a.PCLQCODE || null,
      address: propLoc, property_class: cls, property_class_label: PROP_CLASS_LABEL[cls] || null, facility: a.FAC_NAME || null,
      building: a.BLDG_DESC || null, land_desc: a.LAND_DESC || null, year_built: Number(a.YR_CONSTR) || null,
      dwellings: Number(a.DWELL) || null, commercial_dwellings: Number(a.COMM_DWELL) || null,
      acres: Number(a.CALC_ACRE) > 0 ? Number(a.CALC_ACRE) : (ringsAreaM2(feature.geometry?.rings || []) / 4046.8564224 || null),
      acres_source: Number(a.CALC_ACRE) > 0 ? "state record" : "computed from parcel outline",
      lot_dimensions: /\d+\s*X\s*\d+/i.test(String(a.LAND_DESC || "")) ? String(a.LAND_DESC).trim() : null,
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
    sheriff_sales: await njSheriffSales([propLoc, top.address.split(",")[0], ...variants.map(v => streetPart(v))], String(a.MUN_NAME || ""), String(top.address).match(/\b0[78]\d{3}\b/)?.[0]),
    sources: [
      { name: "NJ Geocoder (NJOGIS)", url: NJ_GEOCODE },
      { name: "Parcels & MOD-IV Composite of NJ (NJOGIS)", url: NJ_PARCELS.replace(/\/query$/, "") },
      { name: "NJ sheriff sales — daily CivilView capture (github.com/aimesy/njss)", url: "https://github.com/aimesy/njss" },
    ],
  };
}
