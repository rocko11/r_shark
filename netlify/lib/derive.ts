// The derivation layer — the product. Every output is a range with stated
// assumptions, never a single confident number.

import { DHCR_BBLS } from "./dhcr_data.ts";

const UAP_ELIGIBLE = ["R6", "R7", "R8", "R9", "R10", "R11", "R12"];
const UAP_MAX_BONUS = 0.20;

export interface Scenario {
  name: string; far: number; buildable_sf: number; unused_sf: number; assumptions: string[];
}
export interface Flag {
  code: string; severity: "critical" | "warning" | "info";
  title: string; detail: string; source: string;
}
export interface Derived {
  lot_area: number | null; existing_floor_area: number | null; built_far: number | null;
  zoning_districts: string[]; scenarios: Scenario[]; flags: Flag[]; caveats: string[];
}

function num(v: unknown): number | null {
  if (v === 0 || v === "0") return 0;
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const norm = (d?: string) => (d || "").trim().toUpperCase();

function family(d?: string): string {
  let base = norm(d).split("-")[0];
  while (base && /[A-Z]$/.test(base) && base.length > 2) base = base.slice(0, -1);
  return base;
}

export function developmentRights(pluto: any): Derived {
  const lotArea = num(pluto.lotarea);
  const bldgArea = num(pluto.bldgarea);
  const builtFar = num(pluto.builtfar);
  const residFar = num(pluto.residfar);
  const commFar = num(pluto.commfar);
  const facilFar = num(pluto.facilfar);

  const districts = [1, 2, 3, 4].map((i) => norm(pluto[`zonedist${i}`])).filter(Boolean);

  const caveats: string[] = [
    "Figures are FAR-based and do not account for height, setback, yard, sky " +
    "exposure plane, or lot coverage. A compliant building may not reach the full area.",
    "PLUTO is a periodic snapshot and lags recent subdivisions, mergers, and new " +
    "construction. Verify against DOB filings.",
  ];

  const scenarios: Scenario[] = [];
  const add = (name: string, far: number | null, assumptions: string[]) => {
    if (far === null || lotArea === null || far <= 0) return;
    const buildable = lotArea * far;
    const existing = bldgArea || 0;
    scenarios.push({
      name, far: round2(far), buildable_sf: Math.round(buildable),
      unused_sf: Math.round(buildable - existing), assumptions,
    });
  };

  add("Residential (as-of-right)", residFar, ["Single zoning district assumed."]);
  add("Commercial (as-of-right)", commFar, []);
  add("Community facility (as-of-right)", facilFar, []);

  const fam = districts.length ? family(districts[0]) : "";
  if (residFar && UAP_ELIGIBLE.includes(fam)) {
    add("Residential + UAP (City of Yes)", residFar * (1 + UAP_MAX_BONUS), [
      `Assumes maximum ${UAP_MAX_BONUS * 100}% UAP bonus; actual bonus varies by district.`,
      "Requires permanently affordable housing averaging 60% AMI.",
      "Projects over 10,000 SF must set 20% of affordable units at 40% AMI (Council modification).",
      "Affordable floor area is bonused 1:1.",
      "Model alongside 485-x — the affordability tiers were designed together.",
    ]);
    caveats.push(
      "UAP eligibility inferred from the primary zoning district only. Confirm the " +
      "site is not in a Mandatory Inclusionary Housing area, where different rules apply.");
  }

  if (districts.length > 1) {
    caveats.push(
      `Lot spans multiple zoning districts (${districts.join(", ")}). Split-lot FAR ` +
      "uses the primary district only and is indicative, not reliable.");
  }

  return {
    lot_area: lotArea, existing_floor_area: bldgArea, built_far: builtFar,
    zoning_districts: districts, scenarios, flags: [], caveats,
  };
}

interface FlagInput {
  ecb?: any[]; dobViolations?: any[]; hpdViolations?: any[];
  acrisDocs?: any[]; acrisAvailable?: boolean; derived?: Derived;
  title?: any; eDesignations?: any[];
}

export function redFlags(pluto: any, inp: FlagInput = {}): Flag[] {
  const flags: Flag[] = [];
  const ecb = inp.ecb ?? [], dobV = inp.dobViolations ?? [];
  const hpdV = inp.hpdViolations ?? [], acris = inp.acrisDocs ?? [];

  if (String(pluto.landmark || "").trim()) {
    flags.push({ code: "LANDMARK", severity: "critical", title: "Individual landmark",
      detail: `Designated: ${pluto.landmark}. Demolition and most exterior alterations require LPC approval.`,
      source: "PLUTO" });
  }
  if (String(pluto.histdist || "").trim()) {
    flags.push({ code: "HISTORIC_DISTRICT", severity: "critical", title: "In a historic district",
      detail: `${pluto.histdist}. LPC review applies to exterior work and demolition.`, source: "PLUTO" });
  }

  const unitsRes = num(pluto.unitsres) ?? 0;
  const yearBuilt = num(pluto.yearbuilt) ?? 0;
  const bblClean = String(pluto.bbl ?? "").split(".")[0].padStart(10, "0");
  const onDhcr = DHCR_BBLS.has(bblClean);
  const presumptive = unitsRes >= 6 && yearBuilt > 0 && yearBuilt < 1974;

  if (onDhcr) {
    flags.push({ code: "RENT_STABILIZATION_DHCR", severity: "critical",
      title: "On the DHCR rent-stabilized list",
      detail: `This lot appears on the DHCR rent-stabilized building list${yearBuilt ? `, built ${Math.round(yearBuilt)}` : ""}${unitsRes ? ` with ${Math.round(unitsRes)} residential units` : ""}. ` +
        "At least one unit is registered as stabilized. The list does not give the unit count and is point-in-time — pull a certified DHCR rent roll for the exact number of stabilized units and legal rents. Vacant delivery may be constrained.",
      source: "DHCR building list" });
  } else if (presumptive) {
    flags.push({ code: "POSSIBLE_RENT_STABILIZATION", severity: "critical",
      title: "Likely rent-stabilized — not on DHCR list",
      detail: `${Math.round(unitsRes)} residential units, built ${Math.round(yearBuilt)}. Pre-1974 buildings with 6+ units are presumptively stabilized, but this lot is NOT on the DHCR list. ` +
        "That can mean the owner stopped registering (their compliance problem, and yours after closing) or the building exited — open data can't say which. Order the DHCR registration history before assuming vacant delivery.",
      source: "PLUTO heuristic (not DHCR-listed)" });
  }

  if (inp.derived && inp.derived.built_far !== null) {
    const maxAsOfRight = Math.max(0,
      ...inp.derived.scenarios.filter((s) => s.name.includes("as-of-right")).map((s) => s.far));
    if (maxAsOfRight && inp.derived.built_far > maxAsOfRight * 1.02) {
      flags.push({ code: "OVERBUILT", severity: "warning",
        title: "Existing building exceeds permitted FAR",
        detail: `Built FAR ${inp.derived.built_far} vs. maximum as-of-right ${maxAsOfRight}. The building ` +
          "is non-complying. No as-of-right expansion, and a replacement would be smaller than what stands.",
        source: "PLUTO" });
    }
  }

  const openEcb = ecb.filter((v) => String(v.ecb_violation_status || "").toUpperCase().startsWith("ACTIVE"));
  if (openEcb.length) {
    const money = (x: unknown) => Number(String(x ?? "").replace(/[$,]/g, "")) || 0;
    const balance = openEcb.reduce((s, v) => s + money(v.balance_due), 0);
    let detail = "Active ECB/OATH violations carry monetary penalties and can block issuance of new " +
      "permits until cured. Unpaid ECB fines are docketed as judgments and become liens — title will " +
      "flag these at closing.";
    if (balance) detail += ` Outstanding balance across open violations: $${balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`;
    flags.push({ code: "OPEN_ECB", severity: "critical",
      title: `${openEcb.length} open ECB violation(s)`, detail, source: "DOB ECB Violations" });
  }

  const swo = dobV.filter((v) =>
    String(v.violation_type || "").toUpperCase().includes("STOP WORK") ||
    String(v.violation_type_code || "").toUpperCase() === "SWO");
  if (swo.length) {
    flags.push({ code: "STOP_WORK_ORDER", severity: "critical", title: "Stop Work Order on record",
      detail: `${swo.length} SWO record(s). Verify current status with DOB — the dataset lags rescissions.`,
      source: "DOB Violations" });
  }

  const classC = hpdV.filter((v) => String(v.class || "").toUpperCase() === "C");
  if (classC.length >= 5) {
    flags.push({ code: "HPD_DISTRESS", severity: "warning", title: `${classC.length} Class C HPD violations`,
      detail: "Immediately hazardous violations in volume suggest a distressed asset and an occupied " +
        "building with an active tenant relationship.", source: "HPD Violations" });
  }

  const docTypes = new Set(acris.map((d) => String(d.doc_type || "").toUpperCase()));
  if (docTypes.has("ZLDA")) {
    flags.push({ code: "ZONING_LOT_MERGER", severity: "critical",
      title: "Zoning Lot Development Agreement recorded",
      detail: "This lot is part of a merged zoning lot. Development rights may already have been " +
        "transferred and spent. PLUTO will not reflect this. Read the ZLDA and any amendments before " +
        "relying on any air rights figure.", source: "ACRIS" });
  }
  // Title-analysis-driven flags: open lis pendens, open liens (with amounts),
  // and E-designations. Falls back to nothing if the analysis isn't present.
  const title = inp.title;
  if (title && title.available) {
    const usd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

    const openLP = (title.lis_pendens || []);
    if (openLP.length) {
      const latest = openLP[0];
      const who = (latest.plaintiff || []).filter(Boolean).slice(0, 1).join("");
      flags.push({ code: "LIS_PENDENS", severity: "critical", title: "Lis pendens on record",
        detail: `A foreclosure or title lawsuit was filed${latest.year ? " (" + latest.year + ")" : ""}` +
          `${who ? ", plaintiff " + who : ""}. This does not state the outcome — check the NY courts ` +
          "SCROLL system for whether it is active, dismissed, or proceeding to auction.", source: "ACRIS" });
    }

    const open = (title.liens || []).filter((l: any) => !l.discharged);
    const openMech = open.filter((l: any) => l.kind === "Mechanic's lien");
    const openTax = open.filter((l: any) => /tax lien/i.test(l.kind));
    const openJudg = open.filter((l: any) => l.kind === "Judgment lien");
    if (openMech.length) {
      const amt = openMech.reduce((s: number, l: any) => s + (l.amount || 0), 0);
      flags.push({ code: "MECHANICS_LIEN", severity: "critical",
        title: `${openMech.length} mechanic's lien${openMech.length > 1 ? "s" : ""} with no recorded discharge`,
        detail: `Unpaid-contractor claim against the property${amt ? ", totaling " + usd(amt) : ""}. ` +
          "Must be cleared or bonded before a clean sale. No satisfaction was found in ACRIS — confirm with a title search.",
        source: "ACRIS" });
    }
    if (openTax.length) {
      const amt = openTax.reduce((s: number, l: any) => s + (l.amount || 0), 0);
      flags.push({ code: "TAX_LIEN", severity: "critical",
        title: `${openTax.length} tax lien${openTax.length > 1 ? "s" : ""} with no recorded release`,
        detail: `Federal or other recorded tax lien${amt ? " totaling " + usd(amt) : ""}. Attaches to the ` +
          "property and must be satisfied at closing. Verify current payoff.", source: "ACRIS" });
    }
    if (openJudg.length) {
      flags.push({ code: "JUDGMENT_LIEN", severity: "warning",
        title: `${openJudg.length} judgment lien${openJudg.length > 1 ? "s" : ""} recorded`,
        detail: "A money judgment recorded against an owner can attach to the property. No satisfaction found — verify.",
        source: "ACRIS" });
    }
    // Any other open liens (mortgages excluded from flagging — normal) get a soft note.
    const otherOpen = open.filter((l: any) =>
      l.kind !== "Mechanic's lien" && !/tax lien/i.test(l.kind) && l.kind !== "Judgment lien" && l.kind !== "Mortgage");
    if (otherOpen.length) {
      flags.push({ code: "OTHER_LIEN", severity: "warning",
        title: `${otherOpen.length} other recorded lien${otherOpen.length > 1 ? "s" : ""}`,
        detail: "UCC or other encumbrance with no recorded discharge. Review in the title section below.", source: "ACRIS" });
    }

    if ((title.easements || []).length) {
      flags.push({ code: "EASEMENT", severity: "warning",
        title: `${title.easements.length} recorded easement${title.easements.length > 1 ? "s" : ""}`,
        detail: "Recorded easement or right-of-way affecting the lot. Note: many easements exist only in the deed " +
          "or survey and won't appear here — a survey is the only way to be sure.", source: "ACRIS" });
    }
  }

  // E-designation (CEQR environmental requirement) — real remediation cost.
  const eds = inp.eDesignations || [];
  if (eds.length) {
    const types = [...new Set(eds.map((e: any) => e.type).filter(Boolean))].join(", ");
    flags.push({ code: "E_DESIGNATION", severity: "critical",
      title: `(E) designation on the lot${types ? ": " + types : ""}`,
      detail: "A CEQR environmental requirement (hazardous materials, air quality, and/or noise) is attached to this " +
        "tax lot. It obligates testing and often remediation or mitigation before a new building can be occupied — " +
        "a real, sometimes large, cost line. Pull the (E) requirements before underwriting.", source: "DCP E-Designations" });
  }

  if (inp.acrisAvailable === false) {
    flags.push({ code: "ACRIS_UNAVAILABLE", severity: "warning",
      title: "No ACRIS coverage (Staten Island)",
      detail: "ACRIS does not include Richmond County. Deeds, mortgages, ZLDAs, and liens must be " +
        "pulled from the Richmond County Clerk. Ownership and encumbrance data below is incomplete.",
      source: "system" });
  }

  const order = { critical: 0, warning: 1, info: 2 } as const;
  return flags.sort((a, b) => order[a.severity] - order[b.severity]);
}

const round2 = (n: number) => Math.round(n * 100) / 100;
