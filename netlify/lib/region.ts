// Decide which jurisdiction a free-text address belongs to BEFORE geocoding.
// The NYC geocoders (GeoSearch / Geoclient) only know the five boroughs and will
// happily return "25 Hudson St, Manhattan" for "25 Hudson St, Hoboken NJ" — so
// anything that is clearly outside NYC must be routed (NJ) or rejected (elsewhere).

// "check": has a town we don't recognise and no NYC hint — geocode statewide to decide.
export type Region = "nyc" | "nj" | "nys" | "other" | "check";

const NJ_TOWNS = [
  "JERSEY CITY", "HOBOKEN", "NEWARK", "BAYONNE", "SECAUCUS", "WEEHAWKEN", "UNION CITY", "WEST NEW YORK",
  "NORTH BERGEN", "GUTTENBERG", "KEARNY", "HARRISON", "EAST NEWARK", "ELIZABETH", "PATERSON", "CLIFTON",
  "PASSAIC", "FORT LEE", "EDGEWATER", "CLIFFSIDE PARK", "HACKENSACK", "TEANECK", "ENGLEWOOD", "FAIRVIEW",
  "RIDGEFIELD", "PALISADES PARK", "LEONIA", "LODI", "GARFIELD", "MONTCLAIR", "BLOOMFIELD", "BELLEVILLE",
  "NUTLEY", "IRVINGTON", "EAST ORANGE", "WEST ORANGE", "ORANGE", "MAPLEWOOD", "LINDEN", "RAHWAY", "PLAINFIELD",
  "PERTH AMBOY", "WOODBRIDGE", "NEW BRUNSWICK", "EDISON", "TRENTON", "CAMDEN", "ATLANTIC CITY", "ASBURY PARK",
  "LONG BRANCH", "TOMS RIVER", "LAKEWOOD", "MORRISTOWN", "PARAMUS", "UNION TOWNSHIP", "LYNDHURST", "RUTHERFORD",
];
// Common non-NYC New York State places that NYC geocoders would mis-map to a borough street.
const NYS_PLACES = [
  "YONKERS", "WHITE PLAINS", "MOUNT VERNON", "MT VERNON", "NEW ROCHELLE", "SCARSDALE", "RYE", "PORT CHESTER",
  "HEMPSTEAD", "LONG BEACH", "GLEN COVE", "FREEPORT", "VALLEY STREAM", "GREAT NECK", "GARDEN CITY", "MINEOLA",
  "HICKSVILLE", "LEVITTOWN", "BABYLON", "ISLIP", "HUNTINGTON", "BROOKHAVEN", "SMITHTOWN", "RIVERHEAD",
  "SOUTHAMPTON", "EAST HAMPTON", "NEW CITY", "SPRING VALLEY", "NYACK", "NEWBURGH", "MIDDLETOWN", "POUGHKEEPSIE",
  "KINGSTON", "PEEKSKILL", "OSSINING", "ALBANY", "BUFFALO", "ROCHESTER", "SYRACUSE", "UTICA", "SCHENECTADY",
  "TROY", "BINGHAMTON", "ITHACA", "SARATOGA SPRINGS",
];
const NYC_HINTS = /\b(MANHATTAN|BROOKLYN|BRONX|QUEENS|STATEN ISLAND|NEW YORK,? NY|NYC|ASTORIA|FLUSHING|JAMAICA|HARLEM|WILLIAMSBURG|BUSHWICK|LONG ISLAND CITY|FAR ROCKAWAY|RIDGEWOOD)\b/;

function isNYCZip(z: number) {
  return (z >= 10001 && z <= 10292) || (z >= 10301 && z <= 10314) || (z >= 10451 && z <= 10475)
    || (z >= 11004 && z <= 11005) || (z >= 11101 && z <= 11109) || (z >= 11201 && z <= 11256)
    || (z >= 11351 && z <= 11697);
}

export function detectRegion(address: string): Region {
  const a = ` ${String(address || "").toUpperCase().replace(/[.]/g, "").replace(/\s+/g, " ")} `;
  // A ZIP only counts at the very end or right after a comma / state — never a leading
  // 5-digit house number like "11420 Rockaway Blvd".
  const zipM = a.match(/(?:,|\bNY|\bNJ|NEW YORK|NEW JERSEY)\s*(\d{5})(?:-\d{4})?\b/) || a.match(/\S\s+(\d{5})(?:-\d{4})?\s*$/);
  const zip = zipM ? Number(zipM[1]) : 0;

  if (/,?\s(NJ|N J|NEW JERSEY)\b/.test(a) || (zip >= 7001 && zip <= 8999)) return "nj";
  if (zip) {
    if (isNYCZip(zip)) return "nyc";
    if (zip >= 10001 && zip <= 14999) return "nys";
    return "other";
  }
  if (NYC_HINTS.test(a)) return "nyc";
  // A town name on its own (no state/ZIP) — only trust it after a comma, so
  // "100 Newark Ave" (a street) isn't mistaken for the city of Newark.
  const afterComma = a.includes(",") ? a.slice(a.indexOf(",")) : "";
  if (afterComma) {
    if (NJ_TOWNS.some(t => new RegExp(`\\b${t}\\b`).test(afterComma))) return "nj";
    if (NYS_PLACES.some(t => new RegExp(`\\b${t}\\b`).test(afterComma))) return "nys";
    if (/\b(CT|CONNECTICUT|PA|PENNSYLVANIA|MA|FL|CA|TX)\b/.test(afterComma)) return "other";
  }
  if (/\bHOBOKEN\b|\bJERSEY CITY\b|\bSECAUCUS\b|\bWEEHAWKEN\b/.test(a)) return "nj";
  // Anything left after the street that isn't just a state / country (a town, hamlet, village)
  // might be upstate — let the statewide geocoder decide.
  let tail = afterComma;
  if (!tail) { const m = a.match(/\b(ST|STREET|AVE|AVENUE|RD|ROAD|BLVD|BOULEVARD|PL|PLACE|DR|DRIVE|LN|LANE|TER|TERRACE|CT|COURT|HWY|HIGHWAY|PKWY|PARKWAY|WAY|TPKE|TURNPIKE)\b(.*)$/); tail = m ? m[2] : ""; }
  const rest = tail.replace(/[,]/g, " ").replace(/\b(NY|N Y|NEW YORK STATE|NEW YORK|NYS|USA|US|UNITED STATES)\b/g, " ").replace(/\s+/g, " ").trim();
  if (rest && /[A-Z]{3,}/.test(rest)) return "check";
  return "nyc";
}
