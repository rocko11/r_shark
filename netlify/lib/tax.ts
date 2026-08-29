// Annual property tax estimate. NYC's actual tax BILL is not a single open-data
// field — it's computed by DOF from the taxable assessed value and the tax-class
// rate, then reduced by abatements/exemptions (421-a, J-51, co-op/condo abatement,
// STAR, SCHE, veterans). We compute the unabated baseline precisely from PLUTO's
// assessed values and the published class rates, and flag that the real bill is
// lower where an exemption applies.
//
// Rates: FY2026 FINAL, adopted by City Council Oct 29 2025, retroactive to
// Jul 1 2025 (tax year Jul 2025 – Jun 2026). Verified against nyc.gov/finance.
// These change yearly — update RATES and RATE_YEAR each July.

const RATE_YEAR = "FY2026 (Jul 2025 – Jun 2026)";
const RATES: Record<string, number> = {
  "1": 0.19843, // 1–3 family homes + small mixed-use
  "2": 0.12439, // condos, co-ops, 4+ unit residential
  "3": 0.11108, // utility
  "4": 0.10848, // commercial / industrial
};

function taxClassOf(pluto: any): { code: string; label: string } | null {
  // PLUTO has no taxclass field, but building class (bldgclass) maps to tax class
  // reliably via the DOF building-classification scheme (first letter):
  //   A,B = 1-2 family homes -> Class 1
  //   C,D = walk-up / elevator apartments -> Class 2
  //   R = condos -> Class 2 (mostly); S = mixed small -> Class 1/2
  //   Utility (U) -> Class 3
  //   Everything commercial/industrial/office (E,F,G,H,I,J,K,L,O,W,Z, etc.) -> Class 4
  // Vacant land (V) follows its zoning; we treat as Class 4 unless clearly residential.
  const raw = String(pluto?.taxclass ?? "").trim();
  const explicit = raw.charAt(0);
  const labels: Record<string, string> = {
    "1": "Class 1 · 1–3 family home / small mixed-use",
    "2": "Class 2 · condo, co-op, or 4+ unit residential",
    "3": "Class 3 · utility",
    "4": "Class 4 · commercial / industrial",
  };
  if (["1", "2", "3", "4"].includes(explicit)) return { code: explicit, label: labels[explicit] };

  const bc = String(pluto?.bldgclass ?? "").trim().toUpperCase();
  const letter = bc.charAt(0);
  if (!letter) return null;

  let code: string;
  if (["A", "B"].includes(letter)) code = "1";
  else if (letter === "S") code = "1";              // small mixed-use, primarily residential
  else if (["C", "D", "R"].includes(letter)) code = "2"; // walk-up/elevator apts, condos
  else if (letter === "U") code = "3";              // utility
  else code = "4";                                  // office/retail/industrial/warehouse/etc.

  return { code, label: labels[code] };
}

const money = (n: number) => Math.round(n);

export function estimatePropertyTax(pluto: any): {
  available: boolean;
  reason?: string;
  tax_class?: string;
  rate_year?: string;
  rate_pct?: number;
  assessed_total?: number;
  exempt_total?: number;
  taxable_assessed?: number;
  annual_tax_estimate?: number;
  quarterly?: number;
  effective_rate_note?: string;
  has_exemption?: boolean;
  caveat: string;
} {
  const cls = taxClassOf(pluto);
  const assessTot = Number(pluto?.assesstot) || 0;
  const exemptTot = Number(pluto?.exempttot) || 0;

  if (!cls || assessTot <= 0) {
    return {
      available: false,
      reason: !cls ? "No tax class on the PLUTO record." : "No assessed value on the PLUTO record.",
      caveat: "Property tax can't be estimated without a tax class and assessed value. Check the DOF property page directly.",
    };
  }

  const rate = RATES[cls.code];
  const taxable = Math.max(0, assessTot - exemptTot);
  const annual = taxable * rate;
  const hasExemption = exemptTot > 0;
  const classInferred = !String(pluto?.taxclass ?? "").trim();

  // Class 2/3/4 over $250k assessed bill semi-annually; others quarterly. Show quarterly
  // as the common case; note the semi-annual threshold.
  const quarterly = annual / 4;

  return {
    available: true,
    tax_class: cls.label,
    rate_year: RATE_YEAR,
    rate_pct: rate * 100,
    assessed_total: money(assessTot),
    exempt_total: money(exemptTot),
    taxable_assessed: money(taxable),
    annual_tax_estimate: money(annual),
    quarterly: money(quarterly),
    has_exemption: hasExemption,
    effective_rate_note: `${(rate * 100).toFixed(3)}% of the taxable assessed value (${RATE_YEAR}).`,
    caveat: (classInferred ? "Tax class is inferred from the building class (PLUTO doesn't carry the tax class directly). " : "") + (hasExemption
      ? `This uses PLUTO's assessed and exempt values, so it already nets out the exempt portion on record — but abatements (421-a, J-51, co-op/condo, STAR) that reduce the bill further may not be fully reflected. Treat as an estimate; the DOF bill is authoritative.`
      : `Unabated estimate from assessed value × class rate. If the property has any abatement or exemption (421-a, J-51, co-op/condo abatement, STAR, SCHE, veterans), the actual DOF bill will be lower. Assessed values also update each January; this reflects the value on the current PLUTO record.`),
  };
}
