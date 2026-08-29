import * as sq from "./socrata.ts";
import { ACRIS_BOROUGHS, BOROUGH_NAME, DATASETS, splitBBL } from "./datasets.ts";
import { analyzeTitle } from "./title.ts";
import { ownerPortfolio, ownerContacts } from "./owner.ts";
import { assessRentStabilization } from "./rentstab.ts";
import { estimatePropertyTax } from "./tax.ts";
import { checkArrears } from "./arrears.ts";
import { developmentRights, redFlags } from "./derive.ts";

function chunk<T>(xs: T[], n = 150): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

// PLUTO ownertype codes: C=City, M=Mixed city&private, O=Other public (authority/
// state/federal), P=Private, X=Fully tax-exempt (city/state/fed/authority/private
// institution), blank=Unknown (usually private). We also scan the owner name,
// since the code can lag a recent sale and name patterns are unambiguous.
function classifyOwnership(ownertype: any, ownername: any) {
  const code = String(ownertype ?? "").toUpperCase().trim();
  const name = String(ownername ?? "").toUpperCase();
  const cityName = /\bCITY OF NEW YORK\b|\bNYC (DEPT|DEPARTMENT|HOUSING|HPD|EDC|DCAS)\b|\bNYCHA\b|\bHOUSING AUTHORITY\b|\bDEPT OF|DEPARTMENT OF (HOUSING|TRANSPORTATION|PARKS|CITYWIDE)/.test(name);
  const publicName = /\bSTATE OF NEW YORK\b|\bNEW YORK STATE\b|\bUNITED STATES\b|\bU\.?S\.?A\.?\b|\bPORT AUTHORITY\b|\bMTA\b|\bMETROPOLITAN TRANSPORTATION\b|\bTRANSIT AUTHORITY\b|\bPUBLIC LIBRARY\b|\bHEALTH \+ HOSPITALS\b|\bDORMITORY AUTHORITY\b/.test(name);

  let category: "city" | "public" | "mixed" | "private" | "exempt_unclear";
  let label: string;
  if (code === "C" || cityName) { category = "city"; label = "City-owned"; }
  else if (code === "O" || publicName) { category = "public"; label = "Public (state / federal / authority)"; }
  else if (code === "M") { category = "mixed"; label = "Mixed city & private"; }
  else if (code === "P" || code === "") { category = "private"; label = "Private"; }
  else if (code === "X") { category = "exempt_unclear"; label = "Tax-exempt (owner type unclear)"; }
  else { category = "private"; label = "Private"; }

  // If the name clearly says city/public but the code says private, trust the name and note it.
  if ((cityName || publicName) && (code === "P" || code === "")) {
    category = cityName ? "city" : "public";
    label = cityName ? "City-owned" : "Public (state / federal / authority)";
  }

  const developer_note =
    category === "city" ? "City-owned lots are generally not for sale on the open market; acquisition usually runs through an HPD/EDC disposition or RFP program, or a ground lease."
    : category === "public" ? "Owned by a state/federal body or public authority — typically not a conventional private purchase."
    : category === "mixed" ? "Mixed city and private ownership — confirm exactly which interest is being sold."
    : category === "exempt_unclear" ? "Fully tax-exempt; owner could be a public body or a private institution (church, university, nonprofit). Verify the owner before assuming it's buyable."
    : null;

  return { code: code || null, category, label, is_public: category === "city" || category === "public", developer_note };
}

// ACRIS: Legals -> document_id -> Master + Parties. No address field exists.
async function acris(borough: number, block: number, lot: number) {
  const legals = await sq.query("acris_legals", {
    where: sq.buildWhere({ borough, block, lot }), limit: 500,
  });
  const docIds = [...new Set(legals.map((l) => l.document_id).filter(Boolean))];
  if (!docIds.length) return { documents: [], document_count: 0 };

  const tasks: Record<string, Promise<any>> = {};
  chunk(docIds).forEach((c, i) => {
    tasks[`m${i}`] = sq.query("acris_master", { where: sq.buildIn("document_id", c), limit: 1000 });
    tasks[`p${i}`] = sq.query("acris_parties", { where: sq.buildIn("document_id", c), limit: 2000 });
  });
  const { data } = await sq.gather(tasks);

  const masters = Object.entries(data).filter(([k]) => k.startsWith("m")).flatMap(([, v]) => v || []);
  const parties = Object.entries(data).filter(([k]) => k.startsWith("p")).flatMap(([, v]) => v || []);

  const byDoc: Record<string, any[]> = {};
  for (const p of parties) (byDoc[p.document_id || ""] ??= []).push(p);

  const docs = masters.map((m) => {
    const ps = byDoc[m.document_id || ""] || [];
    return {
      document_id: m.document_id, doc_type: m.doc_type,
      document_date: m.document_date, recorded_datetime: m.recorded_datetime,
      document_amount: m.document_amt,
      grantors: ps.filter((p) => String(p.party_type) === "1").map((p) => p.name),
      grantees: ps.filter((p) => String(p.party_type) === "2").map((p) => p.name),
    };
  });
  docs.sort((a, b) => (b.document_date || "").localeCompare(a.document_date || ""));
  return { documents: docs, document_count: docs.length };
}

// BIS + DOB NOW filings unioned and deduped. Dedup key is filing number, which
// does not collide across the two systems.
function unionDob(nowJobs: any[], bisJobs: any[], nowPermits: any[], bisPermits: any[]) {
  const rows: any[] = [];
  for (const j of nowJobs || []) rows.push({
    system: "DOB NOW", number: j.job_filing_number, job_type: j.job_type,
    status: j.filing_status, date: j.filing_date, description: j.job_description,
    applicant: j.applicant_business_name,
  });
  for (const j of bisJobs || []) rows.push({
    system: "BIS", number: j.job__, job_type: j.job_type,
    status: j.job_status_descrp, date: j.latest_action_date, description: j.job_description,
    applicant: j.applicant_s_first_name,
  });
  const seen = new Set<string>(), deduped: any[] = [];
  for (const r of rows) {
    const k = `${r.system}:${r.number}`;
    if (r.number && !seen.has(k)) { seen.add(k); deduped.push(r); }
  }
  deduped.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  const isType = (r: any, ...codes: string[]) => {
    const t = String(r.job_type || "").toUpperCase();
    return codes.some((c) => t.startsWith(c) || t === c);
  };
  return {
    filings: deduped.slice(0, 100), filing_count: deduped.length,
    new_building: deduped.filter((r) => isType(r, "NB")).slice(0, 10),
    major_alteration: deduped.filter((r) => isType(r, "A1", "ALT-CO")).slice(0, 10),
    demolition: deduped.filter((r) => isType(r, "DM", "FULL DEMO")).slice(0, 10),
    permits_issued: (nowPermits?.length || 0) + (bisPermits?.length || 0),
  };
}

// Two civil-penalty datasets that overlap per DOB's own docs. Dedupe, or a
// clean building looks distressed. ECB is a separate universe — never merge in.
function consolidateViolations(bisV: any[], safetyV: any[], ecb: any[]) {
  const rows: any[] = [];
  for (const v of bisV || []) rows.push({
    system: "BIS", number: v.number || v.isn_dob_bis_viol, type: v.violation_type,
    category: v.violation_category, issue_date: v.issue_date, disposition: v.disposition_comments,
  });
  for (const v of safetyV || []) rows.push({
    system: "DOB NOW", number: v.violation_number || v.number, type: v.violation_type,
    category: v.violation_category, issue_date: v.issue_date, disposition: v.disposition_comments,
  });
  const seen = new Set<string>(), deduped: any[] = [];
  for (const r of rows) {
    const key = r.number || `${r.type}|${r.issue_date}`;
    if (!seen.has(key)) { seen.add(key); deduped.push(r); }
  }
  deduped.sort((a, b) => (b.issue_date || "").localeCompare(a.issue_date || ""));

  const money = (x: unknown) => Number(String(x ?? "").replace(/[$,]/g, "")) || 0;
  const ecbRows = (ecb || []).map((v) => ({
    number: v.ecb_violation_number, status: v.ecb_violation_status, type: v.violation_type,
    severity: v.severity, issue_date: v.issue_date,
    penalty_imposed: v.penality_imposed, // misspelled in source
    amount_paid: v.amount_paid, balance_due: v.balance_due, hearing_status: v.hearing_status,
  })).sort((a, b) => (b.issue_date || "").localeCompare(a.issue_date || ""));
  const openEcb = ecbRows.filter((r) => String(r.status || "").toUpperCase().startsWith("ACTIVE"));

  return {
    dob_civil_penalties: deduped.slice(0, 100), dob_civil_penalty_count: deduped.length,
    dob_raw_count_before_dedup: rows.length,
    ecb: ecbRows.slice(0, 100), ecb_count: ecbRows.length, ecb_open_count: openEcb.length,
    ecb_balance_due_total: Math.round(openEcb.reduce((s, r) => s + money(r.balance_due), 0) * 100) / 100,
  };
}

export async function buildReport(bbl: string, bin: string | null = null) {
  const [borough, block, lot] = splitBBL(bbl);
  const acrisOk = ACRIS_BOROUGHS.has(borough);

  const plutoRows = await sq.query("pluto", { where: sq.buildWhere({ bbl }), limit: 1 });
  if (!plutoRows.length) {
    return { bbl, found: false,
      error: "No PLUTO record for this BBL. It may be a condo unit BBL (use the billing BBL), " +
        "a very recent subdivision, or invalid." };
  }
  const pluto = plutoRows[0];

  const tasks: Record<string, Promise<any>> = {};
  const binWhere = (slug: string) => {
    const ds = DATASETS[slug];
    return bin && ds.binField ? sq.buildWhere({ [ds.binField]: bin }) : null;
  };
  const binSets: [string, number][] = [
    ["dob_now_jobs", 200], ["dob_bis_jobs", 200], ["dob_now_permits", 200],
    ["dob_bis_permits", 200], ["dob_violations", 300], ["dob_safety_violations", 300],
    ["ecb_violations", 300], ["dob_complaints", 200], ["certificates_of_occupancy", 50],
  ];
  for (const [slug, limit] of binSets) {
    const w = binWhere(slug);
    if (w) tasks[slug] = sq.query(slug, { where: w, limit });
  }
  tasks["hpd_violations"] = sq.query("hpd_violations", { where: sq.buildWhere({ bbl }), limit: 500 });
  if (acrisOk) tasks["acris"] = acris(borough, block, lot);
  // E-designations key on borough/block/lot (like ACRIS legals), all boroughs.
  tasks["e_designations"] = sq.query("e_designations", {
    where: sq.buildWhere({ borough, block, lot }), limit: 50,
  });

  const { data, errors } = await sq.gather(tasks);

  const derived = developmentRights(pluto);
  const acrisData = data.acris || { documents: [] };

  // Public vs. private ownership, from PLUTO's ownertype code, cross-checked
  // against the owner name (the code occasionally lags a recent transfer).
  const ownershipType = classifyOwnership(pluto.ownertype, pluto.ownername);

  // Owner intelligence: portfolio (other lots same owner holds) + HPD contact.
  // Run in parallel; both degrade gracefully to {available:false}.
  const [portfolio, contacts] = await Promise.all([
    ownerPortfolio(pluto.ownername, bbl, Number(block), Number(lot)).catch(() => ({ available: false, count: 0, lots: [] })),
    ownerContacts(bbl).catch(() => ({ available: false, contacts: [] })),
  ]);

  const arrears = await checkArrears(bbl).catch(() => ({ available: false, on_lien_sale_list: false, caveat: "Arrears check unavailable." }));

  // Title / ownership / liens / easements / foreclosure analysis from ACRIS docs.
  const title = analyzeTitle(acrisData.documents || [], acrisOk);
  // Attach E-designations (normalize the type field across dataset vintages).
  const eDesigs = (data.e_designations || []).map((e: any) => ({
    enumber: e.enumber || e.e_number, ceqr_number: e.ceqr_number || e.ceqr,
    type: e.e_designatio || e.edesignation || e.type || "Environmental (E)",
  }));
  if (title.available) title.e_designations = eDesigs;

  derived.flags = redFlags(pluto, {
    ecb: data.ecb_violations,
    dobViolations: [...(data.dob_violations || []), ...(data.dob_safety_violations || [])],
    hpdViolations: data.hpd_violations, acrisDocs: acrisData.documents,
    acrisAvailable: acrisOk, derived,
    title, eDesignations: eDesigs,
  });

  // Tax/water arrears on the lien sale list is a critical, deal-shaping flag.
  if (arrears && arrears.on_lien_sale_list) {
    derived.flags.unshift({
      code: arrears.sold ? "TAX_LIEN_SOLD" : "TAX_WATER_ARREARS",
      severity: "critical",
      title: arrears.sold ? "Tax lien SOLD at lien sale" : (arrears.water_only ? "On lien sale list — water/sewer arrears" : "On tax lien sale list — arrears"),
      detail: arrears.caveat,
      source: "DOF Tax Lien Sale List",
    });
  }

  const dob = unionDob(data.dob_now_jobs, data.dob_bis_jobs, data.dob_now_permits, data.dob_bis_permits);
  const violations = consolidateViolations(data.dob_violations, data.dob_safety_violations, data.ecb_violations);

  return {
    bbl, bin, found: true, generated_at: new Date().toISOString(),
    identity: {
      address: pluto.address, borough: BOROUGH_NAME[borough], block, lot,
      owner_of_record: pluto.ownername, building_class: pluto.bldgclass,
      year_built: pluto.yearbuilt, num_floors: pluto.numfloors,
      units_residential: pluto.unitsres, units_total: pluto.unitstotal,
      lot_frontage: pluto.lotfront, lot_depth: pluto.lotdepth,
      irregular_lot: pluto.irrlotcode, assessed_total: pluto.assesstot,
      latitude: pluto.latitude ? Number(pluto.latitude) : null,
      longitude: pluto.longitude ? Number(pluto.longitude) : null,
      ownership_type: ownershipType,
    },
    development: derived,
    owner_intel: { ownership_type: ownershipType, portfolio, contacts },
    rent_stabilization: assessRentStabilization(pluto, bbl),
    property_tax: estimatePropertyTax(pluto),
    arrears,
    dob,
    violations: {
      ...violations,
      hpd_total: (data.hpd_violations || []).length,
      hpd_class_c: (data.hpd_violations || []).filter((v: any) => String(v.class || "").toUpperCase() === "C").length,
      complaints_total: (data.dob_complaints || []).length,
    },
    acris: acrisOk ? acrisData : { available: false,
      reason: "ACRIS excludes Staten Island. Use the Richmond County Clerk." },
    title,
    provenance: { sources_queried: Object.keys(tasks).sort(), sources_failed: errors },
    disclaimer: "Informational only. Not a zoning analysis. Confirm all figures with a licensed " +
      "architect or land use counsel before acting.",
  };
}
