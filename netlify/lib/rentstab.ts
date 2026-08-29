// Rent stabilization assessment. NYC has no clean "this building has N stabilized
// units" open dataset, so we triangulate three signals and report each honestly
// with its own confidence, rather than inventing a precise count:
//
//   1. DHCR list      — is this BBL on the DHCR rent-stabilized building list?
//                       (authoritative-ish, but point-in-time and voluntary.)
//   2. Tax program    — 421-a / J-51 / other abatements carry MANDATORY
//                       stabilization for the benefit period (from PLUTO/exemptions).
//   3. Heuristic      — pre-1974 + 6+ residential units + not condo/coop =
//                       presumptively stabilized under the RSL, even if not listed.
//
// We NEVER output a unit count — that requires a certified DHCR rent roll. We output
// a status, the signals behind it, and what to pull to confirm.

import { DHCR_BBLS } from "./dhcr_data.ts";

type Confidence = "listed" | "tax_program" | "likely" | "possible" | "unlikely";

export function assessRentStabilization(pluto: any, bbl: string): {
  status: string;
  confidence: Confidence;
  on_dhcr_list: boolean;
  signals: string[];
  tax_program: string | null;
  caveat: string;
  action: string;
} {
  const clean = String(bbl).split(".")[0].padStart(10, "0");
  const onList = DHCR_BBLS.has(clean);

  const year = Number(pluto?.yearbuilt) || 0;
  const unitsRes = Number(pluto?.unitsres) || 0;
  const bldg = String(pluto?.bldgclass || "").toUpperCase();
  const isCondoCoop = /^R/.test(bldg) || /^C6|^C8|^D0|^D4/.test(bldg); // rough condo/coop classes
  const pregeq1974 = year > 0 && year < 1974;
  const sixPlus = unitsRes >= 6;

  // Tax-program signals (mandatory stabilization while the benefit runs).
  // PLUTO carries some exemption hints; the authoritative source is DOF exemptions,
  // but we surface what PLUTO exposes and flag the program name if present.
  const exemptFlags: string[] = [];
  const ext = String(pluto?.exemptcl || pluto?.exempttot || "").toUpperCase();
  // 421-a / J-51 don't always appear cleanly in PLUTO; treat these as hints only.
  let taxProgram: string | null = null;
  if (/421A|421-A/.test(ext)) taxProgram = "421-a";
  else if (/J-?51|J51/.test(ext)) taxProgram = "J-51";

  const signals: string[] = [];
  if (onList) signals.push("On the DHCR rent-stabilized building list.");
  if (taxProgram) signals.push(`${taxProgram} tax benefit — carries mandatory stabilization for the benefit period.`);
  if (pregeq1974 && sixPlus && !isCondoCoop) signals.push(`Built ${year} with ${unitsRes} residential units — pre-1974 buildings with 6+ units are presumptively stabilized under the Rent Stabilization Law.`);
  else if (pregeq1974 && sixPlus && isCondoCoop) signals.push(`Pre-1974 with ${unitsRes} units, but the building class looks like a condo/co-op — individual units may or may not be stabilized.`);

  // Decide headline status + confidence, most authoritative signal first.
  let status: string, confidence: Confidence, caveat: string, action: string;

  if (onList) {
    status = "On the DHCR stabilized-building list";
    confidence = "listed";
    caveat = "The DHCR list confirms at least one registered stabilized unit, but it does NOT give the number of stabilized units, and the list is point-in-time and based on voluntary owner registration — it is not determinative of current status.";
    action = "Pull a certified DHCR rent roll (registration history) for the exact stabilized unit count and legal rents before underwriting vacancy or buyout assumptions.";
  } else if (taxProgram) {
    status = `Stabilized via ${taxProgram} tax benefit`;
    confidence = "tax_program";
    caveat = `${taxProgram} requires stabilization while the benefit runs; units may deregulate when it expires. PLUTO's program flags are approximate.`;
    action = `Confirm the ${taxProgram} benefit term and which units are restricted; check the DOF exemption record and the DHCR registration.`;
  } else if (pregeq1974 && sixPlus && !isCondoCoop) {
    status = "Likely stabilized (pre-1974, 6+ units) — not on the DHCR list";
    confidence = "likely";
    caveat = "Presumptively stabilized under the RSL by age and size, but not found on the DHCR list. That can mean the owner stopped registering (a compliance problem for them), or the building genuinely exited — you cannot tell which from open data.";
    action = "Order the DHCR rent-registration history. A pre-1974 6+ unit building missing from the list is a red flag worth resolving before closing.";
  } else if (pregeq1974 && sixPlus && isCondoCoop) {
    status = "Possibly stabilized — pre-1974 6+ units but condo/co-op class";
    confidence = "possible";
    caveat = "Condo and co-op buildings can still contain individually stabilized units (e.g. non-purchasing tenants after conversion). Building class is a rough signal.";
    action = "Check the DHCR registration and the condo/co-op offering plan for any remaining stabilized units.";
  } else {
    status = "No stabilization signal found";
    confidence = "unlikely";
    caveat = year === 0 || unitsRes === 0
      ? "Missing year-built or unit-count data, so the heuristic can't run — absence of a signal here is not evidence the building is free-market."
      : "Not on the DHCR list, no tax-program flag, and doesn't meet the pre-1974/6-unit test. Free-market status is likely but not guaranteed — ETPA, Loft Law, and other paths exist.";
    action = "If any units are occupied, a DHCR rent-registration check is still the only way to be certain.";
  }

  return { status, confidence, on_dhcr_list: onList, signals, tax_program: taxProgram, caveat, action };
}
