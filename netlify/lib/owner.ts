// Owner intelligence: portfolio (other lots the same owner holds) and contact
// info (HPD registration head officer / managing agent — the closest open data
// gets to a human behind an LLC).
//
// Hard limit, stated plainly to the user everywhere this surfaces: NYC open data
// does NOT link an LLC to the individuals who own it. The best we can do is:
//   - the registered "head officer" / "individual owner" on the HPD filing, and
//   - a business/mailing address for notices.
// Anything past that needs NY State entity filings (often just a registered
// agent) or a paid skip-trace.

import * as sq from "./socrata.ts";

// Normalize an owner name so "SMITH REALTY, LLC" and "SMITH REALTY LLC  " match.
// We strip punctuation and common entity suffixes to get a comparable root, but
// keep it conservative — over-normalizing merges unrelated owners.
export function ownerRoot(name: any): string {
  return String(name ?? "")
    .toUpperCase()
    .replace(/[.,'"]/g, " ")
    .replace(/\b(LLC|L L C|INC|CORP|CO|LP|LLP|LTD|TRUST|ASSOC|ASSOCIATES|REALTY|HOLDINGS|MANAGEMENT|MGMT|PROPERTIES|GROUP|PARTNERS)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A name is too generic to portfolio-match on (would return garbage).
function tooGenericToMatch(root: string): boolean {
  if (root.length < 4) return true;
  // Public/placeholder owners that appear on thousands of lots.
  return /\b(CITY OF NEW YORK|NYC|HOUSING AUTHORITY|NYCHA|PARKS|DEPT|DEPARTMENT|STATE OF NEW YORK|UNITED STATES|N\/?A|UNKNOWN|UNAVAILABLE|SAME|OWNER)\b/.test(root);
}

// Are two lots physically adjacent (share the block and are within a couple lot
// numbers)? Cheap heuristic for the assemblage signal — not a true geometry test.
function looksAdjacent(selfBlock: number, selfLot: number, block: number, lot: number): boolean {
  return block === selfBlock && Math.abs(lot - selfLot) <= 3 && lot !== selfLot;
}

export async function ownerPortfolio(ownername: any, selfBbl: string, selfBlock: number, selfLot: number) {
  const raw = String(ownername ?? "").trim();
  const root = ownerRoot(raw);
  if (!raw || tooGenericToMatch(root)) {
    return { available: false, reason: "Owner name is public/placeholder or too generic to match a portfolio reliably.", count: 0, lots: [] };
  }

  // Pick a distinctive anchor word to LIKE-match on. Prefer the first meaningful
  // token (usually the actual name — ESRT, BELTO), skipping generic words that
  // would over-match ("BUILDING", "STATE", "PARK", etc.).
  const GENERIC = new Set(["BUILDING","BUILDINGS","STATE","EMPIRE","PARK","PARKS","AVENUE","STREET","PLACE","EAST","WEST","NORTH","SOUTH","NEW","YORK","CITY","APARTMENTS","APARTMENT","HOUSE","HOUSING","TOWER","TOWERS","PLAZA","CENTER","CENTRE","MANOR","GARDENS","GARDEN","COURT","MANAGEMENT","REALTY","PROPERTIES","ASSOCIATES","DEVELOPMENT"]);
  const words = root.split(" ").filter(w => w.length >= 4);
  const anchor = words.find(w => !GENERIC.has(w)) || words.sort((a, b) => b.length - a.length)[0];
  if (!anchor) {
    return { available: false, reason: "Owner name has no distinctive token to match a portfolio.", count: 0, lots: [] };
  }
  const like = `%${anchor.replace(/'/g, "''")}%`;
  let rows: any[] = [];
  try {
    rows = await sq.query("pluto", {
      where: `upper(ownername) like '${like}'`,
      select: "bbl,address,ownername,borough,block,lot,bldgclass,lotarea,unitsres,unitstotal,assesstot,latitude,longitude",
      limit: 500,
    });
  } catch {
    return { available: false, reason: "Portfolio lookup failed.", count: 0, lots: [] };
  }

  // The LIKE anchor can over-match (e.g. "EMPIRE" catches unrelated "EMPIRE" owners),
  // so re-filter in JS to rows whose normalized root shares the full owner root.
  const selfRoot = root;
  rows = rows.filter((r) => {
    const rr = ownerRoot(r.ownername);
    return rr === selfRoot || rr.includes(selfRoot) || selfRoot.includes(rr);
  });

  const norm = (v: any) => (v == null || v === "" ? null : Number(v));
  const cleanBbl = (v: any) => String(v ?? "").split(".")[0].padStart(10, "0");

  const others = rows
    .map((r) => ({
      bbl: cleanBbl(r.bbl),
      address: r.address || cleanBbl(r.bbl),
      block: norm(r.block), lot: norm(r.lot),
      bldg_class: r.bldgclass,
      lot_area: norm(r.lotarea),
      units_total: norm(r.unitstotal),
      assessed_total: norm(r.assesstot),
      lat: norm(r.latitude), lng: norm(r.longitude),
      adjacent: looksAdjacent(selfBlock, selfLot, norm(r.block) ?? -1, norm(r.lot) ?? -1),
    }))
    .filter((l) => l.bbl !== cleanBbl(selfBbl)); // exclude the subject lot

  // Rank: adjacent first (assemblage), then largest by lot area.
  others.sort((a, b) =>
    Number(b.adjacent) - Number(a.adjacent) ||
    (b.lot_area || 0) - (a.lot_area || 0)
  );

  const adjacentCount = others.filter((l) => l.adjacent).length;
  const totalArea = others.reduce((s, l) => s + (l.lot_area || 0), 0);
  const totalAssessed = others.reduce((s, l) => s + (l.assessed_total || 0), 0);

  return {
    available: true,
    owner_matched: raw,
    count: others.length,               // number of OTHER lots (excl. subject)
    adjacent_count: adjacentCount,
    total_other_lot_area: totalArea,
    total_other_assessed: totalAssessed,
    lots: others.slice(0, 12),          // cap the list; count reflects the full set
    note: adjacentCount > 0
      ? `This owner holds ${adjacentCount} lot(s) adjacent to the subject — a possible assemblage. Exact-name match only; entities with slightly different names elsewhere may not be counted.`
      : "Exact owner-name match across PLUTO. Owners recorded under slightly different names (punctuation, suffix, or a different LLC) won't be caught here.",
  };
}

// HPD registration contact — head officer / individual owner / managing agent.
// Two-hop: registrations (by boro/block/lot) -> registrationid -> contacts (by
// registrationid). NOTE: the registrations dataset (tesw-yqqr) has NO bbl column —
// it keys on boroid + block + lot, so we split the BBL.
export async function ownerContacts(bbl: string) {
  const clean = String(bbl).split(".")[0].padStart(10, "0");
  const boroid = clean.slice(0, 1);
  const block = String(Number(clean.slice(1, 6)));  // strip leading zeros
  const lot = String(Number(clean.slice(6, 10)));
  let regs: any[] = [];
  try {
    regs = await sq.query("hpd_registrations", {
      where: `boroid='${boroid}' AND block='${block}' AND lot='${lot}'`,
      select: "registrationid,lastregistrationdate,registrationenddate,housenumber,streetname,zip",
      limit: 5,
    });
  } catch {
    return { available: false, reason: "No HPD registration lookup (building may not be a registered multiple dwelling).", contacts: [] };
  }
  if (!regs.length) {
    return { available: false, reason: "No HPD registration on file — typically means fewer than 3 units or owner-occupied; no managing-agent contact is published.", contacts: [] };
  }

  // Newest registration wins.
  regs.sort((a, b) => String(b.lastregistrationdate || "").localeCompare(String(a.lastregistrationdate || "")));
  const reg = regs[0];

  let contacts: any[] = [];
  try {
    contacts = await sq.query("hpd_contacts", {
      where: `registrationid='${String(reg.registrationid).replace(/'/g, "''")}'`,
      select: "type,firstname,lastname,corporationname,businesshousenumber,businessstreetname,businessapartment,businesscity,businessstate,businesszip",
      limit: 50,
    });
  } catch {
    return { available: false, reason: "HPD contacts lookup failed.", contacts: [] };
  }

  // Rank contact types by usefulness for reaching a decision-maker.
  const rank: Record<string, number> = {
    HEADOFFICER: 0, INDIVIDUALOWNER: 1, CORPORATEOWNER: 2, OFFICER: 3, AGENT: 4, SITEMANAGER: 5,
  };
  const cleaned = contacts.map((c) => {
    const t = String(c.type || "").toUpperCase().replace(/\s+/g, "");
    const person = [c.firstname, c.lastname].filter(Boolean).join(" ").trim();
    // HPD sometimes stores the house number inside businessstreetname too, which
    // produces "2307 2307 EASTCHESTER ROAD". Only prepend the house number if the
    // street doesn't already start with it.
    const hn = String(c.businesshousenumber || "").trim();
    const st = String(c.businessstreetname || "").trim();
    const street = hn && !st.startsWith(hn) ? [hn, st].filter(Boolean).join(" ") : st;
    const addr = [
      street,
      c.businessapartment ? "Apt/Ste " + String(c.businessapartment).trim() : "",
      [c.businesscity, c.businessstate, c.businesszip].filter(Boolean).map(s => String(s).trim()).join(", "),
    ].filter(Boolean).join(", ").replace(/\s{2,}/g, " ");
    return {
      role: c.type || "Contact",
      role_key: t,
      name: c.corporationname || person || null,
      person: person || null,
      business_address: addr || null,
      rank: rank[t] ?? 9,
    };
  })
  .filter((c) => c.name || c.business_address)
  .sort((a, b) => a.rank - b.rank);

  return {
    available: cleaned.length > 0,
    registration_id: reg.registrationid,
    registered_through: reg.registrationenddate || null,
    contacts: cleaned.slice(0, 6),
    note: "From the building's HPD registration. A 'Head Officer' or 'Individual Owner' is often a real person behind the LLC; the business address is where legal notices go. This is the closest open data gets to the human owner — it is not a guarantee of beneficial ownership.",
  };
}
