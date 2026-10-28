// What the zoning on a lot actually means — district by district.
//
// Every number below is transcribed from the NYC Zoning Resolution as amended by City of Yes
// for Housing Opportunity (adopted 12/5/2024), read from zr.planning.nyc.gov on 2026-10-28:
//   §23-21  max residential FAR, R1–R5 (standard / qualifying residential sites)
//   §23-22  max residential FAR, R6–R12 (standard / qualifying affordable or senior housing)
//   §23-421, §23-422, §23-424  heights R1–R5      §23-432  heights R6–R12
//   §23-361, §23-362  lot coverage                §24-11   community facility FAR + coverage
//   §33-121 commercial FAR in C1/C2 overlays & C1-1..C2-5     §33-122 commercial FAR, other C districts
//   §33-123 community facility FAR, other C districts          §34-112 residential equivalents
//   §43-12  manufacturing FAR (last amended 6/6/2024)
// Lot-specific facts come live from: DCP Zoning Tax Lot Database (fdkv-4t4z), DCP layers for
// Mandatory Inclusionary Housing areas (nycmih) and special-district subdistricts (nysp_sd), and
// the Transit Zones dataset (6ztr-wgff, City of Yes parking geography).
// This is a summary for screening deals; the Zoning Resolution and a zoning attorney/expediter govern.

const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || "";
const ZTL = "https://data.cityofnewyork.us/resource/fdkv-4t4z.json";
const TRANSIT = "https://data.cityofnewyork.us/resource/6ztr-wgff.json";
const DCP = "https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services";

async function getJSON(url: string, ms = 6000): Promise<any> {
  const socrata = url.includes("data.cityofnewyork.us");
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: socrata && APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {} });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j && !Array.isArray(j) && j.error) throw new Error(j.error.message || "service error");
  return j;
}
const arcPoint = (svc: string, lat: number, lon: number, fields: string) =>
  `${DCP}/${svc}/FeatureServer/0/query?${new URLSearchParams({ geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
    spatialRel: "esriSpatialRelIntersects", outFields: fields, returnGeometry: "false", f: "json" })}`;

/* ------------------------------------------------------------------ tables */

type FarPair = { std: number; bonus: number };
// R1–R5 (§23-21). bonus = "qualifying residential sites".
const R_LOW_FAR: [string[], FarPair][] = [
  [["R1-1", "R1-2", "R1-2A", "R2", "R2A", "R3-1", "R3-2", "R3A", "R3X"], { std: 0.75, bonus: 1.0 }],
  [["R2X"], { std: 1.0, bonus: 1.0 }],
  [["R4", "R4-1", "R4A", "R4B"], { std: 1.0, bonus: 1.5 }],
  [["R5", "R5A", "R5B"], { std: 1.5, bonus: 2.0 }],
  [["R5D"], { std: 2.0, bonus: 2.0 }],
];
// R6–R12 (§23-22 FAR, §23-432 heights). "wide" = within 100 ft of a wide street; "narrow" = beyond.
// h = [minBase, maxBase, maxHeight] standard; hq = [maxBase, maxHeight] qualifying affordable/senior.
type RHigh = { std: number; bonus: number; h: [number, number, number]; hq: [number, number]; note?: string };
const R_HIGH: Record<string, { all?: RHigh; wide?: RHigh; narrow?: RHigh }> = {
  "R6A": { all: { std: 3.0, bonus: 3.9, h: [40, 65, 75], hq: [65, 95] } },
  "R6-1": { all: { std: 3.0, bonus: 3.9, h: [40, 65, 75], hq: [65, 95] } },
  "R6": { wide: { std: 3.0, bonus: 3.9, h: [40, 65, 75], hq: [65, 95] }, narrow: { std: 2.2, bonus: 3.9, h: [30, 45, 55], hq: [65, 85] } },
  "R6B": { all: { std: 2.0, bonus: 2.4, h: [30, 45, 55], hq: [45, 65] } },
  "R6D": { all: { std: 2.5, bonus: 3.0, h: [30, 45, 65], hq: [55, 75] } },
  "R6-2": { all: { std: 2.5, bonus: 3.0, h: [30, 45, 65], hq: [55, 75] } },
  "R7B": { all: { std: 3.0, bonus: 3.9, h: [40, 65, 75], hq: [65, 95] } },
  "R7A": { all: { std: 4.0, bonus: 5.01, h: [40, 75, 85], hq: [85, 115] } },
  "R7-1": { wide: { std: 4.0, bonus: 5.01, h: [40, 75, 85], hq: [85, 115] }, narrow: { std: 3.44, bonus: 5.01, h: [40, 65, 75], hq: [85, 105] } },
  "R7-2": { wide: { std: 4.0, bonus: 5.01, h: [40, 75, 85], hq: [85, 115] }, narrow: { std: 3.44, bonus: 5.01, h: [40, 65, 75], hq: [85, 105] } },
  "R7D": { all: { std: 4.66, bonus: 5.6, h: [60, 85, 105], hq: [95, 125] } },
  "R7X": { all: { std: 5.0, bonus: 6.0, h: [60, 95, 125], hq: [105, 145] } },
  "R7-3": { all: { std: 5.0, bonus: 6.0, h: [60, 95, 125], hq: [105, 145] } },
  "R8A": { all: { std: 6.02, bonus: 7.2, h: [60, 95, 125], hq: [105, 145] } },
  "R8X": { all: { std: 6.02, bonus: 7.2, h: [60, 95, 155], hq: [105, 175] } },
  "R8": {
    wide: { std: 7.2, bonus: 8.64, h: [60, 95, 135], hq: [105, 145], note: "Outside MIH areas, UAP / senior housing within 100 ft of a wide street may reach 8.64 FAR with a 125 ft base and 175 ft max height." },
    narrow: { std: 6.02, bonus: 7.2, h: [60, 85, 115], hq: [105, 145] },
  },
  "R8B": { all: { std: 4.0, bonus: 4.8, h: [55, 65, 75], hq: [85, 95] } },
  "R9A": { wide: { std: 7.52, bonus: 9.02, h: [60, 105, 145], hq: [135, 185] }, narrow: { std: 7.52, bonus: 9.02, h: [60, 95, 135], hq: [135, 185] } },
  "R9": { wide: { std: 7.52, bonus: 9.02, h: [60, 105, 145], hq: [135, 185] }, narrow: { std: 7.52, bonus: 9.02, h: [60, 95, 135], hq: [135, 185] } },
  "R9D": { all: { std: 9.0, bonus: 10.8, h: [60, 125, 175], hq: [155, 215] } },
  "R9-1": { all: { std: 9.0, bonus: 10.8, h: [60, 125, 175], hq: [155, 215] } },
  "R9X": { wide: { std: 9.0, bonus: 10.8, h: [105, 125, 175], hq: [155, 215] }, narrow: { std: 9.0, bonus: 10.8, h: [60, 125, 165], hq: [155, 215] } },
  "R10": { wide: { std: 10.0, bonus: 12.0, h: [60, 155, 215], hq: [155, 235] }, narrow: { std: 10.0, bonus: 12.0, h: [60, 125, 185], hq: [155, 235] } },
  "R10X": { wide: { std: 10.0, bonus: 12.0, h: [60, 155, 215], hq: [155, 235] }, narrow: { std: 10.0, bonus: 12.0, h: [60, 125, 185], hq: [155, 235] } },
  "R10A": { wide: { std: 10.0, bonus: 12.0, h: [125, 155, 215], hq: [155, 235] }, narrow: { std: 10.0, bonus: 12.0, h: [60, 125, 185], hq: [155, 235] } },
  "R11": { all: { std: 12.0, bonus: 15.0, h: [60, 155, 255], hq: [155, 325] } },
  "R11A": { wide: { std: 12.0, bonus: 15.0, h: [125, 155, 255], hq: [155, 325] }, narrow: { std: 12.0, bonus: 15.0, h: [60, 155, 255], hq: [155, 325] } },
  "R12": { all: { std: 15.0, bonus: 18.0, h: [60, 155, 325], hq: [155, 395] } },
};
// Community facility FAR in residence districts (§24-11).
const R_CF: Record<string, number> = {
  R1: 1, R2: 1, R3: 1, R4: 2, R5: 2, R5A: 2, R5B: 2, R5D: 2,
  R6A: 3, R6B: 2, R6D: 2.5, R7A: 4, R7B: 3, R7D: 4.66, R7X: 5, R8A: 6.5, R8B: 4, R8X: 6, R9A: 7.5, R9D: 9, R9X: 9,
  R10A: 10, R10X: 10, R11A: 12, R6: 4.8, "R6-1": 4.8, "R6-2": 2.5, "R7-1": 4.8, "R7-2": 6.5, "R7-3": 6.5, R8: 6.5,
  R9: 10, "R9-1": 10, R10: 10, R11: 12, R12: 15,
};
// Commercial FAR inside a C1/C2 overlay, or C1-1..C2-5, by the residence district it's mapped in (§33-121 col. A / B).
const OVERLAY_FAR: [string[], number, number][] = [ // [districts, commercial-only, community facility-only]
  [["R1", "R2"], 1.0, 0.5], [["R3-1", "R3A", "R3X"], 1.0, 1.0], [["R3-2"], 1.6, 1.6], [["R4", "R5"], 2.0, 2.0],
  [["R5D", "R6B"], 2.0, 2.0], [["R6D", "R6-2"], 2.0, 2.5], [["R6A", "R7B"], 2.0, 3.0], [["R7A", "R8B"], 2.0, 4.0],
  [["R7D"], 2.0, 4.66], [["R6", "R6-1", "R7-1"], 2.0, 4.8], [["R7X"], 2.0, 5.0], [["R7-2", "R7-3", "R8", "R8A"], 2.0, 6.5],
  [["R8X"], 2.0, 6.0], [["R9", "R9-1"], 2.0, 10.0], [["R9A"], 2.0, 7.5], [["R9D"], 2.0, 9.0], [["R9X"], 2.0, 9.0],
  [["R10"], 2.0, 10.0], [["R11"], 2.0, 12.0], [["R12"], 2.0, 15.0],
];
// Commercial-only FAR, other commercial districts (§33-122).
const C_FAR: [string[], number][] = [
  [["C3"], 0.5], [["C4-1", "C8-1"], 1.0],
  [["C1-6", "C1-7", "C1-8", "C1-9", "C2-6", "C2-7", "C2-8", "C7-1", "C8-2", "C8-3"], 2.0],
  [["C4-2A", "C4-3A", "C7-2"], 3.0],
  [["C4-2", "C4-2F", "C4-3", "C4-4", "C4-4D", "C4-5", "C4-6", "C4-8", "C4-9", "C4-11", "C4-12"], 3.4],
  [["C4-4A", "C4-4L", "C4-5A", "C4-5X", "C5-1", "C7-3"], 4.0], [["C4-5D"], 4.2], [["C7-4", "C8-4"], 5.0],
  [["C6-1", "C6-2", "C6-3"], 6.0], [["C7-5"], 6.5], [["C7-6"], 8.0], [["C6-3D"], 9.0],
  [["C4-7", "C5-2", "C5-4", "C6-4", "C6-5", "C6-8", "C7-7"], 10.0], [["C6-11", "C7-8"], 12.0],
  [["C5-3", "C5-5", "C6-6", "C6-7", "C6-9", "C6-12", "C7-9"], 15.0],
];
// Community facility FAR, other commercial districts (§33-123).
const C_CF: [string[], number][] = [
  [["C3"], 1.0], [["C4-1", "C7-1"], 2.0], [["C8-1"], 2.4], [["C4-2A", "C4-3A", "C7-2"], 3.0],
  [["C1-6A", "C2-6A", "C4-4A", "C4-4L", "C4-5A", "C7-3"], 4.0], [["C4-5D"], 4.2], [["C4-2", "C4-3", "C8-2"], 4.8],
  [["C4-5X", "C7-4"], 5.0], [["C6-1A"], 6.0],
  [["C1-6", "C1-7", "C2-6", "C4-2F", "C4-4", "C4-4D", "C4-5", "C4-8", "C6-1", "C6-2", "C7-5", "C8-3", "C8-4"], 6.5],
  [["C1-8A", "C2-7A", "C6-3A"], 7.5], [["C7-6"], 8.0], [["C1-8X", "C2-7X", "C6-3D", "C6-3X"], 9.0],
  [["C1-8", "C1-9", "C2-7", "C2-8", "C4-6", "C4-7", "C4-9", "C5-1", "C5-2", "C5-4", "C6-3", "C6-4", "C6-5", "C6-8", "C7-7"], 10.0],
  [["C4-11", "C6-11", "C7-8"], 12.0], [["C4-12", "C5-3", "C5-5", "C6-6", "C6-7", "C6-9", "C6-12", "C7-9"], 15.0],
];
// Residential equivalents of commercial districts (§34-112).
const C_REQ: [string[], string][] = [
  [["C3"], "R3-2"], [["C4-1"], "R5"], [["C4-2", "C4-3", "C6-1A"], "R6"], [["C4-2A", "C4-3A"], "R6A"],
  [["C1-6", "C2-6", "C4-4", "C4-5", "C6-1"], "R7-2"], [["C1-6A", "C2-6A", "C4-4A", "C4-4L", "C4-5A"], "R7A"],
  [["C4-5D"], "R7D"], [["C4-5X"], "R7X"], [["C1-7", "C4-2F", "C4-8", "C6-2"], "R8"], [["C1-7A", "C4-4D", "C6-2A"], "R8A"],
  [["C1-8", "C2-7", "C4-9", "C6-3"], "R9"], [["C1-8A", "C2-7A", "C6-3A"], "R9A"], [["C6-3D"], "R9D"],
  [["C1-8X", "C2-7X", "C6-3X"], "R9X"],
  [["C1-9", "C2-8", "C4-6", "C4-7", "C5", "C5-1", "C5-2", "C5-3", "C5-4", "C5-5", "C6-4", "C6-5", "C6-6", "C6-7", "C6-8", "C6-9"], "R10"],
  [["C1-9A", "C2-8A", "C4-6A", "C4-7A", "C5-1A", "C5-2A", "C6-4A"], "R10A"], [["C6-4X"], "R10X"],
  [["C4-11", "C6-11"], "R11"], [["C4-11A"], "R11A"], [["C4-12", "C6-12"], "R12"],
];
// Manufacturing FAR (§43-12).
const M_FAR: [string[], number][] = [
  [["M1-1"], 1.0], [["M1-2", "M1-4", "M2-1", "M2-3", "M3", "M3-1", "M3-2"], 2.0], [["M1-3", "M1-5", "M2-2", "M2-4"], 5.0], [["M1-6"], 10.0],
];

const SPECIAL: Record<string, string> = {
  "125th": "Special 125th Street District", AAM: "Special Atlantic Avenue Mixed Use District", BNY: "Special Brooklyn Navy Yard District",
  BPC: "Special Battery Park City District", BR: "Special Bay Ridge District", BSC: "Special Bay Street Corridor District",
  C: "Special Grand Concourse Preservation District", CD: "Special City Island District", CI: "Special Coney Island District",
  CL: "Special Clinton District", CO: "Special Coney Island Mixed Use District", CP: "Special College Point District",
  "CR-1": "Special Coastal Risk District 1", "CR-2": "Special Coastal Risk District 2", "CR-3": "Special Coastal Risk District 3",
  "CR-4": "Special Coastal Risk District 4", "CR-5": "Special Coastal Risk District 5", DB: "Special Downtown Brooklyn District",
  DFR: "Special Downtown Far Rockaway District", DJ: "Special Downtown Jamaica District",
  "EC-1": "Special Enhanced Commercial District 1", "EC-2": "Special Enhanced Commercial District 2", "EC-3": "Special Enhanced Commercial District 3",
  "EC-4": "Special Enhanced Commercial District 4", "EC-5": "Special Enhanced Commercial District 5", "EC-6": "Special Enhanced Commercial District 6",
  EHC: "Special East Harlem Corridors District", ETC: "Special Eastchester – East Tremont Corridor District", FH: "Special Forest Hills District",
  FW: "Special Flushing Waterfront District", G: "Special Gowanus Mixed-Use District", GI: "Special Governors Island District",
  HP: "Special Hunts Point District", HRP: "Special Hudson River Park District", HRW: "Special Harlem River Waterfront District",
  HS: "Special Hillsides Preservation District", HSQ: "Special Hudson Square District", HY: "Special Hudson Yards District",
  IN: "Special Inwood District", J: "Special Jerome Corridor District", L: "Special Lincoln Square District",
  LC: "Special Limited Commercial District", LI: "Special Little Italy District", LIC: "Special Long Island City Mixed Use District",
  LM: "Special Lower Manhattan District", MiD: "Special Midtown District", MMU: "Special Manhattanville Mixed Use District",
  MP: "Special Madison Avenue Preservation District", MSX: "Special Midtown South Mixed-Use District",
  "NA-1": "Special Natural Area District 1", "NA-2": "Special Natural Area District 2", "NA-3": "Special Natural Area District 3",
  "NA-4": "Special Fort Totten Natural Area District 4", OP: "Special Ocean Parkway District", PC: "Special Planned Community Preservation District",
  PI: "Special Park Improvement District", SB: "Special Sheepshead Bay District", SG: "Special St. George District",
  SHP: "Special Southern Hunters Point District", SNX: "Special SoHo-NoHo Mixed Use District", SRD: "Special South Richmond Development District",
  SRI: "Special Southern Roosevelt Island District", "SV-1": "Special Scenic View District", SW: "Special Stapleton Waterfront District",
  TA: "Special Transit Land Use District", TMU: "Special Tribeca Mixed Use District", U: "Special United Nations Development District",
  WCh: "Special West Chelsea District", WP: "Special Willets Point District", US: "Special Union Square District",
};
const specialName = (code: string) => SPECIAL[code] || (/^MX-\d+$/.test(code) ? `Special Mixed Use District (${code})` : `Special district ${code}`);

/* ------------------------------------------------------------------ helpers */
// Standard and affordable/senior ("UAP") residential FAR for a district, from the tables above.
// Where FAR differs by street width, returns the narrow-street (conservative) value plus the wide one.
export function residentialFar(code: string): { std: number; bonus: number; wideStd?: number; wideBonus?: number; low: boolean } | null {
  const c = String(code || "").trim().toUpperCase();
  const lowRow = find(R_LOW_FAR, c);
  if (lowRow) return { ...lowRow, low: true };
  const r = R_HIGH[c] || R_HIGH[c.replace(/^(R\d+)(-\d+)?[A-Z]*$/, (m: string, a: string, b: string) => a + (b || ""))];
  if (!r) return null;
  const base = r.all || r.narrow!;
  return { std: base.std, bonus: base.bonus, ...(r.wide && r.narrow ? { wideStd: r.wide.std, wideBonus: r.wide.bonus } : {}), low: false };
}
const find = <T,>(rows: [string[], T][], code: string) => rows.find(([ds]) => ds.includes(code))?.[1];
const baseOf = (code: string) => code.replace(/^([CM]\d-\d+)[A-Z.\d]*$/, "$1").replace(/^(R\d+)(-\d+)?[A-Z]*$/, (m, a, b) => a + (b || ""));
const lowFamily = (code: string) => (code.match(/^R(\d+)/) || [])[1];

const R_DESC: Record<string, string> = {
  R1: "Lowest-density residence district: large detached one-family homes.",
  R2: "Low-density residence district: detached one-family homes (R2A: with limits on house size; R2X: larger homes on smaller lots).",
  R3: "Low-density residence district: detached and semi-detached one- and two-family homes (R3A/R3X detached; R3-2 also allows small multifamily).",
  R4: "Low-density residence district: one- and two-family houses and small multifamily buildings (R4A detached, R4B rowhouses, R4-1 one/two-family).",
  R5: "Medium-low density residence district: rowhouses and small apartment buildings (R5A detached, R5B rowhouses, R5D small apartment buildings).",
  R6: "Medium-density residence district: apartment buildings. Letter-suffix versions (A/B/D) are contextual Quality Housing districts with street-wall and height rules.",
  R7: "Medium-density residence district: mid-rise apartment buildings (A/B/D/X contextual versions use Quality Housing street-wall and height rules).",
  R8: "High-density residence district: larger apartment buildings (R8B is the contextual brownstone-block version).",
  R9: "High-density residence district: tall apartment buildings, typically on wide avenues.",
  R10: "Highest-density residence district (with R11–R12): towers in Manhattan and downtown centers.",
  R11: "Very high-density residence district created by City of Yes for central areas.",
  R12: "Highest-density residence district created by City of Yes for central areas.",
};
function rDesc(code: string) { const f = code.match(/^R(\d+)/)?.[1]; return R_DESC[`R${f}`] || "Residence district."; }

function cDesc(code: string) {
  const t = code.match(/^C(\d)/)?.[1];
  return ({
    "1": "Local retail district (C1): neighborhood shops and services serving the surrounding residential area; residential allowed under the equivalent residence district.",
    "2": "Local service district (C2): a wider range of local services than C1 (e.g. funeral homes, repair shops); residential allowed under the equivalent residence district.",
    "3": "Waterfront recreation district: boating and recreation uses; residential follows the R3-2 equivalent.",
    "4": "General commercial district: regional shopping centers and department stores outside the central business districts; residential allowed under the equivalent residence district.",
    "5": "Restricted central commercial district: retail, offices and residences in high-density central areas (continuous retail frontage).",
    "6": "General central commercial district: high-density offices, hotels, retail and residences in Manhattan, Downtown Brooklyn, LIC and similar centers.",
    "7": "Commercial amusement district: large open amusement parks; new residences not permitted.",
    "8": "General service district: automotive and heavy commercial services (gas stations, auto repair, showrooms); new residences not permitted.",
  } as Record<string, string>)[t || ""] || "Commercial district.";
}
function mDesc(code: string) {
  const t = code.match(/^M(\d)/)?.[1];
  return ({
    "1": "Light manufacturing district: light industry, warehouses, offices and many commercial uses; new residences not permitted (except in paired M1/R mixed-use districts).",
    "2": "Medium manufacturing district: industry with moderate performance standards; residences not permitted.",
    "3": "Heavy manufacturing district: heavy industry, utilities and industrial uses with the least restrictive standards; residences not permitted.",
  } as Record<string, string>)[t || ""] || "Manufacturing district.";
}

const ZR = {
  r_low_far: "https://zr.planning.nyc.gov/article-ii/chapter-3/23-21",
  r_high_far: "https://zr.planning.nyc.gov/article-ii/chapter-3/23-22",
  r_low_h: "https://zr.planning.nyc.gov/article-ii/chapter-3/23-42",
  r_high_h: "https://zr.planning.nyc.gov/article-ii/chapter-3/23-432",
  cf: "https://zr.planning.nyc.gov/article-ii/chapter-4/24-11",
  c_overlay: "https://zr.planning.nyc.gov/article-iii/chapter-3/33-121",
  c_far: "https://zr.planning.nyc.gov/article-iii/chapter-3/33-122",
  c_req: "https://zr.planning.nyc.gov/article-iii/chapter-4/34-112",
  m_far: "https://zr.planning.nyc.gov/article-iv/chapter-3/43-12",
};

/* ------------------------------------------------------------------ describe one district */
export interface FarLine { label: string; value: string; note?: string }
export interface DistrictInfo {
  code: string; kind: "residence" | "commercial" | "manufacturing" | "mixed" | "park" | "other";
  name: string; description: string;
  residential_equivalent?: string | null;
  far: FarLine[]; heights: FarLine[]; coverage?: string | null;
  notes: string[]; zr: { label: string; url: string }[];
  table_match: "exact" | "base" | "none";
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

function residenceBulk(code: string, info: DistrictInfo, label = "") {
  const pre = label ? `${label} ` : "";
  const low = lowFamily(code);
  if (low && Number(low) <= 5) {
    const far = find(R_LOW_FAR, code) || find(R_LOW_FAR, baseOf(code));
    if (far) {
      info.far.push({ label: `${pre}Residential FAR`, value: fmt(far.std), note: "standard zoning lot" });
      if (far.bonus > far.std) info.far.push({ label: `${pre}Residential FAR — qualifying residential site`, value: fmt(far.bonus),
        note: "City of Yes: e.g. 5,000+ sf lots in the Greater Transit Zone on a wide street or short end of a block (not R1/R2), lots with existing community-facility space, or senior housing in some districts (ZR §12-10)" });
      if (far.std === 0.75) info.notes.push("On standard lots of 4,000 sf or more, floor area per single dwelling unit is capped at 0.60 FAR (§23-21 note 1).");
      info.zr.push({ label: "§23-21 FAR", url: ZR.r_low_far });
    } else info.table_match = "none";
    // heights
    if (["R4B"].includes(code)) info.heights.push({ label: `${pre}Max building height`, value: "25 ft" });
    else if (code === "R5B") info.heights.push({ label: `${pre}Max building height`, value: "35 ft" });
    else if (code === "R5D") info.heights.push({ label: `${pre}Max building height`, value: "45 ft" });
    else if (code === "R5") info.heights.push({ label: `${pre}Max base / building height`, value: "35 ft / 45 ft" });
    else info.heights.push({ label: `${pre}Max height`, value: "25 ft perimeter wall, 35 ft ridge", note: "pitched-roof envelope for 1–2 family homes (§23-421); 35 ft max otherwise in R3-2/R4" });
    const q = Number(low) <= 3 ? "35 ft / 35 ft" : Number(low) === 4 ? "35 ft / 45 ft" : "45 ft / 55 ft";
    info.heights.push({ label: `${pre}Qualifying residential site / senior housing`, value: q, note: "max base / building height (§23-424)" });
    info.zr.push({ label: "§23-42 heights", url: ZR.r_low_h });
    const cov = Number(low) <= 2 ? "40% interior / 80% corner" : Number(low) === 3 ? "50% interior / 80% corner" : "60% interior / 80% corner";
    info.coverage = `${cov} for 1–2 family homes; 80% interior / 100% corner for multiple dwellings (§23-361)`;
  } else {
    const row = R_HIGH[code] || R_HIGH[baseOf(code)];
    if (!row) { info.table_match = "none"; return; }
    const show = (r: RHigh, where: string) => {
      info.far.push({ label: `${pre}Residential FAR${where}`, value: fmt(r.std), note: "standard residences" });
      info.far.push({ label: `${pre}Residential FAR${where} — UAP / affordable or senior`, value: fmt(r.bonus),
        note: "qualifying affordable housing (MIH, UAP or regulatory agreement) or qualifying senior housing" });
      info.heights.push({ label: `${pre}Heights${where}`, value: `base ${r.h[0]}–${r.h[1]} ft, max ${r.h[2]} ft`, note: "standard residences" });
      info.heights.push({ label: `${pre}Heights${where} — affordable / senior`, value: `base up to ${r.hq[0]} ft, max ${r.hq[1]} ft` });
      if (r.note) info.notes.push(r.note);
    };
    if (row.all) show(row.all, "");
    if (row.wide) show(row.wide, " (within 100 ft of a wide street)");
    if (row.narrow) show(row.narrow, " (narrow street, beyond 100 ft of a wide street)");
    info.zr.push({ label: "§23-22 FAR", url: ZR.r_high_far }, { label: "§23-432 heights", url: ZR.r_high_h });
    info.coverage = "80% interior or through lots / 100% corner lots (§23-362)";
  }
  const cf = R_CF[code] ?? R_CF[baseOf(code)] ?? (low ? R_CF[`R${low}`] : undefined);
  if (cf) { info.far.push({ label: `${pre}Community facility FAR`, value: fmt(cf) }); info.zr.push({ label: "§24-11 community facility", url: ZR.cf }); }
}

export function residentialEquivalent(code: string): string | null {
  const c = String(code || "").trim().toUpperCase();
  const pair = c.match(/\/(R[\d-]+[A-Z]?)$/); if (pair) return pair[1];
  if (/^C[78]/.test(c) || !/^C/.test(c)) return null;
  const base = c.replace(/^(C\d-\d+)[A-Z.\dGMT]*$/, "$1");
  return find(C_REQ, c) ?? find(C_REQ, base) ?? null;
}

export function describeDistrict(raw: string): DistrictInfo {
  const code = String(raw || "").trim().toUpperCase();
  const info: DistrictInfo = { code, kind: "other", name: code, description: "", far: [], heights: [], notes: [], zr: [], table_match: "exact" };
  if (!code) return info;
  if (code === "PARK" || code === "PARKNY" || code === "PARKUS") {
    info.kind = "park"; info.name = "Park"; info.description = "Mapped parkland — not developable under zoning."; return info;
  }
  if (code === "BPC") { info.kind = "other"; info.name = "Battery Park City"; info.description = "Governed by the Special Battery Park City District and the Battery Park City Authority's controls."; return info; }

  // Paired M1 / R districts (MX special mixed-use districts): manufacturing + residential side by side.
  const pair = code.match(/^(M\d-\d+[A-Z]?)\/(R[\d-]+[A-Z]?)$/);
  if (pair) {
    const m = describeDistrict(pair[1]), r = describeDistrict(pair[2]);
    info.kind = "mixed"; info.name = `${pair[1]} / ${pair[2]} paired mixed-use district`;
    info.description = `Mixed Use (MX) pairing: light manufacturing/commercial under ${pair[1]} and residential under ${pair[2]} on the same lot — residences, workplaces and some light industry can sit side by side.`;
    info.residential_equivalent = pair[2];
    info.far = [...m.far.map(f => ({ ...f, label: `${pair[1]}: ${f.label}` })), ...r.far.map(f => ({ ...f, label: `${pair[2]}: ${f.label}` }))];
    info.heights = r.heights.map(h => ({ ...h, label: `${pair[2]}: ${h.label}` }));
    info.coverage = r.coverage; info.notes = [...m.notes, ...r.notes, "Mixed-use district rules (ZR Article XII Chapter 3) can modify these — e.g. use restrictions near residences."];
    info.zr = [...m.zr, ...r.zr]; info.table_match = m.table_match === "exact" && r.table_match === "exact" ? "exact" : "base";
    return info;
  }

  if (/^R\d/.test(code)) {
    info.kind = "residence"; info.name = `${code} residence district`; info.description = rDesc(code);
    if (!R_HIGH[code] && !find(R_LOW_FAR, code)) info.table_match = "base";
    residenceBulk(code, info);
    if (/^R\d+(A|B|D|X)$/.test(code)) info.notes.push("Contextual (Quality Housing) district: buildings must meet street-wall and base-height rules — the tall-and-skinny tower option isn't available.");
    return info;
  }

  if (/^C\d/.test(code)) {
    info.kind = "commercial"; info.name = `${code} commercial district`; info.description = cDesc(code);
    const lowC = /^C[12]-[1-5]$/.test(code);
    if (lowC) {
      info.notes.push(`${code} is normally mapped as an overlay or within a residence district; its commercial FAR depends on that residence district (§33-121): 1.0–2.0 for commercial use.`);
      info.zr.push({ label: "§33-121", url: ZR.c_overlay });
      return info;
    }
    const exact = find(C_FAR, code);
    const base = code.replace(/^(C\d-\d+)[A-Z.\dGMT]*$/, "$1");
    const cf = find(C_FAR, code) ?? find(C_FAR, base);
    if (!exact) info.table_match = cf != null ? "base" : "none";
    if (cf != null) info.far.push({ label: "Commercial FAR", value: fmt(cf), note: exact ? undefined : `per base district ${base}` });
    const ccf = find(C_CF, code) ?? find(C_CF, base);
    if (ccf != null) info.far.push({ label: "Community facility FAR", value: fmt(ccf) });
    info.zr.push({ label: "§33-122 commercial FAR", url: ZR.c_far }, { label: "§33-123 community facility FAR", url: ZR.c_far.replace("33-122", "33-123") });
    if (/^C[78]/.test(code)) { info.residential_equivalent = null; info.notes.push("New residential use is not permitted in C7 and C8 districts."); return info; }
    const req = find(C_REQ, code) ?? find(C_REQ, base) ?? (code.startsWith("C5") ? "R10" : null);
    if (req) {
      info.residential_equivalent = req;
      info.zr.push({ label: "§34-112 residential equivalent", url: ZR.c_req });
      residenceBulk(req, info, `${req}-equivalent`);
      info.far = info.far.filter(f => !/^R[\d-]+[A-Z]?-equivalent Community facility FAR/.test(f.label));
    }
    return info;
  }

  if (/^M\d/.test(code)) {
    info.kind = "manufacturing"; info.name = `${code} manufacturing district`; info.description = mDesc(code);
    const base = code.replace(/^(M\d-\d+)[A-Z]*$/, "$1");
    const f = find(M_FAR, code) ?? find(M_FAR, base) ?? (code.startsWith("M3") ? 2.0 : undefined);
    if (f != null) info.far.push({ label: "Manufacturing / commercial FAR", value: fmt(f), note: code !== base ? `per base district ${base}; suffix districts have their own rules (§43-13 for A-suffix, §43-61 for D-suffix)` : undefined });
    if (code !== base) info.table_match = "base";
    if (/^M1-\dD$/.test(code)) info.notes.push(`${code}: a "D" suffix M1 district has special rules for residential use (§43-61).`);
    info.zr.push({ label: "§43-12 FAR", url: ZR.m_far });
    return info;
  }
  info.table_match = "none";
  return info;
}

/* ------------------------------------------------------------------ live lot lookups */
export async function fetchZoningLot(bbl: string) {
  const rows = await getJSON(`${ZTL}?${new URLSearchParams({ bbl, $limit: "1" })}`);
  const r = rows?.[0];
  if (!r) return null;
  const pick = (k: string, n: number) => Array.from({ length: n }, (_, i) => r[`${k}_${i + 1}`]).filter(Boolean).map((s: string) => String(s).trim());
  return {
    districts: pick("zoning_district", 4), overlays: pick("commercial_overlay", 2), specials: pick("special_district", 3),
    limited_height: r.limited_height_district || null, map_number: r.zoning_map_number || null, map_code: r.zoning_map_code || null,
  };
}
export async function fetchPointZoning(lat: number, lon: number) {
  const [tz, mih, sd] = await Promise.allSettled([
    getJSON(`${TRANSIT}?${new URLSearchParams({ $select: "transtzone", $where: `intersects(the_geom,'POINT(${lon} ${lat})')` })}`),
    getJSON(arcPoint("nycmih", lat, lon, "ProjectNam,MIH_Option,DateAdopte")),
    getJSON(arcPoint("nysp_sd", lat, lon, "SPNAME,SPLBL,SUBDIST,SUB_AREA_NM,SUBDIST_LBL,SUBAREA_LBL")),
  ]);
  const zone = tz.status === "fulfilled" ? (tz.value?.[0]?.transtzone || null) : undefined;
  const mihF = mih.status === "fulfilled" ? (mih.value.features || []).map((f: any) => f.attributes) : undefined;
  const sdF = sd.status === "fulfilled" ? (sd.value.features || []).map((f: any) => f.attributes) : undefined;
  return {
    transit_zone: zone,
    mih: mihF === undefined ? undefined : mihF.length ? { in_area: true, project: mihF[0].ProjectNam || null, options: mihF[0].MIH_Option || null,
      adopted: mihF[0].DateAdopte ? new Date(mihF[0].DateAdopte).toISOString().slice(0, 10) : null } : { in_area: false },
    subdistricts: sdF === undefined ? undefined : sdF.map((a: any) => [a.SUBDIST, a.SUB_AREA_NM].filter(Boolean).join(" — ") + (a.SPNAME ? ` (${a.SPNAME})` : "")).filter(Boolean),
  };
}

const PARKING: Record<string, string> = {
  "Manhattan Core and Long Island City Parking Areas": "No residential parking required (Manhattan Core / LIC parking area).",
  "Inner Transit Zone": "No residential parking required (Inner Transit Zone, City of Yes).",
  "Outer Transit Zone": "Some residential parking required; certain housing types (incl. most affordable) need none.",
  "Special 25-241 Parking Provisions": "Parking required under the special §25-241 provisions; affordable housing needs significantly less.",
  "Beyond the Greater Transit Zone": "Residential parking required; affordable housing needs less and certain housing types none.",
};

/* ------------------------------------------------------------------ build the section */
export function buildZoning(opts: {
  districts: string[]; overlays: string[]; specials: string[]; limited_height?: string | null; map_number?: string | null;
  point?: Awaited<ReturnType<typeof fetchPointZoning>> | null; lotArea?: number | null; bbl: string; source: string;
  pluto?: { residfar?: any; commfar?: any; facilfar?: any };
}) {
  const { districts, overlays, specials, point } = opts;
  const out: any = {
    source: opts.source,
    districts: districts.map(describeDistrict),
    overlays: overlays.map(o => {
      const host = districts.find(d => /^R/.test(d)) || "";
      const row = OVERLAY_FAR.find(([ds]) => ds.includes(host) || ds.includes(host.replace(/[A-Z]$/, "")));
      return {
        code: o,
        description: /^C1/.test(o) ? "C1 commercial overlay: local retail and services (grocery, restaurants, salons) on the ground floors of the residential district."
          : "C2 commercial overlay: a wider range of local services than C1 (adds e.g. funeral homes, repair services).",
        commercial_far: row ? fmt(row[1]) : null, host_district: host || null,
        note: "Overlays are usually mapped 100–200 ft deep along avenues; commercial floor area is generally limited to the lower floors when residences are above.",
        zr: { label: "§33-121", url: ZR.c_overlay },
      };
    }),
    special_districts: specials.map(s => ({ code: s, name: specialName(s) })),
    subdistricts: point?.subdistricts || [],
    limited_height: opts.limited_height || null,
    map_number: opts.map_number || null,
    mih: point?.mih ?? null,
    transit_zone: point?.transit_zone ?? null,
    parking: point?.transit_zone ? PARKING[point.transit_zone] || null : null,
    pluto_far: opts.pluto ? { residential: num(opts.pluto.residfar), commercial: num(opts.pluto.commfar), community_facility: num(opts.pluto.facilfar) } : null,
    links: {
      zola: `https://zola.planning.nyc.gov/l/lot/${opts.bbl[0]}/${Number(opts.bbl.slice(1, 6))}/${Number(opts.bbl.slice(6))}`,
      zr: "https://zr.planning.nyc.gov/",
    },
    notes: [] as string[],
  };
  const hasHighR = out.districts.some((d: DistrictInfo) => /R([6-9]|1[0-2])/.test(d.residential_equivalent || d.code));
  if (hasHighR && point?.mih) {
    out.notes.push(point.mih.in_area
      ? `Inside a Mandatory Inclusionary Housing area (${point.mih.project}${point.mih.options ? ", " + point.mih.options : ""}): new residential projects over 10 units / 12,500 sf must include permanently affordable housing, and the higher "affordable" FAR applies through MIH rather than UAP.`
      : "Not in a Mandatory Inclusionary Housing area: the higher FAR is available through the Universal Affordability Preference (UAP) — the extra floor area must be affordable housing averaging 60% AMI.");
  }
  const lowR = out.districts.some((d: DistrictInfo) => /^R[1-5]/.test(d.code) && d.kind === "residence");
  if (lowR && opts.lotArea != null && point?.transit_zone) {
    const inGTZ = point.transit_zone !== "Beyond the Greater Transit Zone";
    const r12 = districts.every(d => /^R[12]/.test(d));
    out.notes.push(opts.lotArea >= 5000 && inGTZ && !r12
      ? `Lot is ${Math.round(opts.lotArea).toLocaleString()} sf in the Greater Transit Zone: it may be a "qualifying residential site" (higher FAR) if it fronts a wide street or the short end of a block.`
      : `Probably not a "qualifying residential site" for the City of Yes transit-oriented bonus (${opts.lotArea < 5000 ? "under 5,000 sf" : !inGTZ ? "outside the Greater Transit Zone" : "R1/R2 district"}), unless it has existing community-facility space or is senior housing.`);
  }
  if (districts.length > 1) out.notes.push(`The lot is split between ${districts.join(" and ")}: each district's rules apply to its portion (§77-00), so the totals below are not additive.`);
  if (opts.limited_height) out.notes.push(`Limited Height District ${opts.limited_height}: building height is capped below what the base district allows.`);
  if (out.districts.some((d: DistrictInfo) => d.table_match !== "exact"))
    out.notes.push("One or more districts here has its own variant rules (suffix or special district); figures shown are for the base district — check the ZR text for the exact numbers.");
  return out;
}
const num = (v: any) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
