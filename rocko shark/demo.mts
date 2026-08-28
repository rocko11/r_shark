import type { Config, Context } from "@netlify/functions";
import { developmentRights, redFlags } from "../lib/derive.ts";

// A fixture with the shape of a real report, so the frontend renders before you
// have API keys. Deliberately a hard case: overbuilt pre-war walk-up in a
// special district, open ECB balance, recorded ZLDA.
export default async (_req: Request, _ctx: Context) => {
  const pluto = {
    address: "412 WEST 46 STREET", lotarea: "2510", bldgarea: "15300",
    builtfar: "6.1", residfar: "6.02", commfar: "0", facilfar: "6.5",
    zonedist1: "R8A", yearbuilt: "1912", numfloors: "5", unitsres: "20",
    histdist: "Special Clinton District",
  };
  const ecb = [{ ecb_violation_number: "35112884M", ecb_violation_status: "ACTIVE",
    violation_type: "CONSTRUCTION", issue_date: "20250114", severity: "Class 1",
    penality_imposed: "10,000.00", balance_due: "12,500.00", hearing_status: "DEFAULTED" }];

  const dev = developmentRights(pluto);
  dev.flags = redFlags(pluto, {
    ecb, hpdViolations: Array(7).fill({ class: "C" }),
    acrisDocs: [{ doc_type: "ZLDA" }, { doc_type: "DEED" }],
    acrisAvailable: true, derived: dev,
  });

  const body = {
    bbl: "1010560029", bin: "1024312", found: true,
    generated_at: "2026-08-27T14:20:00+00:00",
    identity: {
      address: pluto.address, borough: "Manhattan", block: 1056, lot: 29,
      owner_of_record: "W46 HOLDINGS LLC", building_class: "C1", year_built: 1912,
      num_floors: 5, units_residential: 20, units_total: 21, lot_frontage: 25,
      lot_depth: 100, assessed_total: 1840500,
    },
    development: dev,
    dob: {
      filing_count: 2, permits_issued: 3,
      filings: [
        { system: "DOB NOW", number: "M00541234-I1", job_type: "A2", status: "Permit Entire",
          date: "2024-08-14", description: "Interior renovation of apartments 3A and 3B, no change to egress." },
        { system: "BIS", number: "121889432", job_type: "A1", status: "Signed Off",
          date: "2016-04-02", description: "Legalize cellar as accessory storage, amend certificate of occupancy." },
      ],
    },
    violations: {
      dob_civil_penalty_count: 2, dob_raw_count_before_dedup: 3, ecb_open_count: 1,
      ecb_balance_due_total: 12500, hpd_total: 41, hpd_class_c: 7, complaints_total: 12,
    },
    acris: {
      document_count: 3,
      documents: [
        { document_id: "2021093000891001", doc_type: "ZLDA", document_date: "2021-09-30",
          document_amount: "0", grantors: ["W46 HOLDINGS LLC"], grantees: ["450 W46 OWNER LLC"] },
        { document_id: "2019051400412002", doc_type: "MTGE", document_date: "2019-05-14",
          document_amount: "8750000", grantors: ["W46 HOLDINGS LLC"], grantees: ["SIGNATURE BANK"] },
        { document_id: "2016021100233004", doc_type: "DEED", document_date: "2016-02-11",
          document_amount: "11200000", grantors: ["ESTATE OF M CONWAY"], grantees: ["W46 HOLDINGS LLC"] },
      ],
    },
    provenance: { sources_queried: ["pluto", "acris", "dob_now_jobs"], sources_failed: {} },
    disclaimer: "Informational only. Not a zoning analysis.",
  };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
};

export const config: Config = { path: "/api/demo" };
