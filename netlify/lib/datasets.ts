// Single source of truth for every NYC Open Data (Socrata) dataset.
// Verified 2026-08-27 against the live portal. Re-run /api/canary on a schedule;
// IDs and field names drift, DOB especially.
//
// DOB SPLITS ITS DATA. Filings: BIS (legacy) + DOB NOW. Violations: THREE sets —
// 3h2n-5cm9 (older, BIS), 855j-jady (newer, DOB NOW), 6bgk-3dad (ECB/OATH).
// The two civil-penalty sets overlap per DOB's own docs, so dedupe.

export type KeyType = "bbl" | "bin" | "bbl_parts" | "doc_id" | "none";

export interface Dataset {
  slug: string;
  socrataId: string;
  key: KeyType;
  verified: boolean;
  canaryField: string;       // canary $selects this to detect schema drift
  bblField?: string;
  binField?: string;
  orderBy?: string;
  notes?: string;
}

export const BASE = "https://data.cityofnewyork.us/resource";

export const DATASETS: Record<string, Dataset> = {
  pluto: { slug: "pluto", socrataId: "64uk-42ks", key: "bbl", verified: true,
    canaryField: "bbl", bblField: "bbl",
    notes: "Version 26v1. Snapshot — lags subdivisions and new construction." },

  // ACRIS: no address field. Legals(borough/block/lot) -> document_id ->
  // Master(amounts) + Parties(names). Excludes Staten Island.
  acris_legals: { slug: "acris_legals", socrataId: "8h5j-fqxa", key: "bbl_parts",
    verified: true, canaryField: "document_id" },
  acris_master: { slug: "acris_master", socrataId: "bnx9-e6tj", key: "doc_id",
    verified: true, canaryField: "document_id", orderBy: "document_date DESC",
    notes: "Fields: document_id, doc_type, document_date, document_amt, recorded_datetime. NOT doc_date/doc_amount." },
  acris_parties: { slug: "acris_parties", socrataId: "636b-3b5g", key: "doc_id",
    verified: true, canaryField: "document_id",
    notes: "party_type 1 = grantor/seller, 2 = grantee/buyer" },
  acris_doc_codes: { slug: "acris_doc_codes", socrataId: "7isb-wh4c", key: "none",
    verified: false, canaryField: "doc_type" },

  // E-designations: CEQR environmental requirements (hazmat / air / noise) on a
  // tax lot. Keyed borough/block/lot like ACRIS legals. A real cost line.
  e_designations: { slug: "e_designations", socrataId: "hxm3-23vy", key: "bbl",
    verified: true, canaryField: "enumber", bblField: "bbl",
    notes: "DCP E-Designations (was jsrs-ggnx, whose borough column was dropped). Fields: enumber, bbl, hazmat_code, air_code, noise_code, description, ceqr_num, effective_date." },

  // DOB filings
  dob_now_jobs: { slug: "dob_now_jobs", socrataId: "w9ak-ipjd", key: "bin",
    verified: true, canaryField: "job_filing_number", binField: "bin", orderBy: "filing_date DESC" },
  dob_now_permits: { slug: "dob_now_permits", socrataId: "rbx6-tga4", key: "bin",
    verified: true, canaryField: "job_filing_number", binField: "bin", orderBy: "issued_date DESC" },
  dob_bis_jobs: { slug: "dob_bis_jobs", socrataId: "ic3t-wcy2", key: "bin",
    verified: true, canaryField: "job__", binField: "bin__", orderBy: "latest_action_date DESC",
    notes: "Legacy BIS. Fields carry trailing double underscores: job__, bin__." },
  dob_bis_permits: { slug: "dob_bis_permits", socrataId: "by8u-8ck5", key: "bin",
    verified: true, canaryField: "job__", binField: "bin__", orderBy: "issuance_date DESC" },

  // DOB violations (three datasets)
  dob_violations: { slug: "dob_violations", socrataId: "3h2n-5cm9", key: "bin",
    verified: true, canaryField: "isn_dob_bis_viol", binField: "bin", orderBy: "issue_date DESC",
    notes: "OLDER civil penalties from BIS." },
  dob_safety_violations: { slug: "dob_safety_violations", socrataId: "855j-jady", key: "bin",
    verified: true, canaryField: "bin", binField: "bin",
    notes: "NEWER civil penalties in DOB NOW. Overlaps 3h2n-5cm9 — dedupe." },
  ecb_violations: { slug: "ecb_violations", socrataId: "6bgk-3dad", key: "bin",
    verified: true, canaryField: "ecb_violation_number", binField: "bin", orderBy: "issue_date DESC",
    notes: "OATH/ECB summonses. penality_imposed is misspelled in source. Date is issue_date." },

  dob_complaints: { slug: "dob_complaints", socrataId: "eabe-havv", key: "bin",
    verified: true, canaryField: "complaint_number", binField: "bin", orderBy: "date_entered DESC" },
  certificates_of_occupancy: { slug: "certificates_of_occupancy", socrataId: "bs8b-p36w",
    key: "bin", verified: true, canaryField: "job_number", binField: "bin" },

  hpd_violations: { slug: "hpd_violations", socrataId: "wvxf-dwi5", key: "bbl",
    verified: true, canaryField: "violationid", bblField: "bbl", orderBy: "inspectiondate DESC",
    notes: "Housing Maintenance Code Violations. Class A/B/C/I." },
  hpd_registrations: { slug: "hpd_registrations", socrataId: "tesw-yqqr", key: "bbl",
    verified: false, canaryField: "registrationid", bblField: "bbl" },
  hpd_contacts: { slug: "hpd_contacts", socrataId: "feu5-w2e2", key: "registrationid",
    verified: false, canaryField: "registrationid", bblField: null,
    notes: "Registration Contacts. type=HeadOfficer/IndividualOwner/CorporateOwner/Agent, firstname, lastname, corporationname, business address. Join on registrationid." },

  // LPC Individual Landmarks: keyed by bbl. Covers individually designated and
  // interior landmarks. Historic district membership requires a separate geo lookup.
  // Individual Landmark Sites — buis-pvji. Has bbl (10-digit), lpc_name, landmarkty,
  // lpc_lpnumb, desdate, borough, block, lot, address. Only individually designated
  // landmarks; historic district buildings are in a separate polygon dataset.
  lpc_landmarks: { slug: "lpc_landmarks", socrataId: "buis-pvji", key: "bbl",
    verified: true, canaryField: "lpc_name", bblField: "bbl",
    notes: "Fields: bbl, lpc_name, lpc_lpnumb, landmarkty, desdate, borough, block, lot, address." },

  tax_lien_sale: { slug: "tax_lien_sale", socrataId: "9rz4-mjek", key: "block",
    verified: false, canaryField: "cycle", bblField: null,
    notes: "Tax Lien Sale List. Keyed borough+block+lot (no bbl). Fields: month, cycle (10/30/60/90 Day Notice, Final Sale), water_debt_only (YES/NO/Y/N). Threshold signal — no dollar amount." },

  // HPD Complaints & Problems (ygpa-z7cr) — 311 housing complaints routed to HPD.
  // Each row is a problem (heat, hot water, pests, leaks, etc.). Keyed bbl + bin.
  // Fields: received_date, major_category, minor_category, type (EMERGENCY/NON EMERGENCY/etc.),
  // complaint_status (OPEN/CLOSE), problem_status, status_description, apartment.
  hpd_complaints: { slug: "hpd_complaints", socrataId: "ygpa-z7cr", key: "bbl",
    verified: true, canaryField: "complaint_id", bblField: "bbl", binField: "bin",
    orderBy: "received_date DESC",
    notes: "One row per problem. complaint_status OPEN/CLOSE. type=EMERGENCY/NON EMERGENCY/IMMEDIATE EMERGENCY/HAZARDOUS. major_category + minor_category describe the condition." },

  // HPD Order to Repair / Vacate Orders (tb8q-a3ar) — orders to vacate due to
  // unsafe/uninhabitable conditions. Keyed bbl + bin.
  // Fields: vacate_order_number, primary_vacate_reason, vacate_type (Partial/Entire Building),
  // vacate_effective_date, actual_rescind_date (null = still active), number_of_vacated_units.
  hpd_vacate_orders: { slug: "hpd_vacate_orders", socrataId: "tb8q-a3ar", key: "bbl",
    verified: true, canaryField: "vacate_order_number", bblField: "bbl", binField: "bin",
    orderBy: "vacate_effective_date DESC",
    notes: "active = actual_rescind_date is null. primary_vacate_reason: Fire Damage, Illegal Occupancy, Habitability, Structural, etc." },

  // HPD Housing Litigations (59kj-x8nc) — Housing Court actions against owners.
  // Keyed bbl + bin. Fields: litigationid, casetype, caseopendate, casestatus (CLOSED/PENDING),
  // casejudgement (OpenJudgement field), findingofharassment, findingdate, penalty, respondent.
  hpd_litigations: { slug: "hpd_litigations", socrataId: "59kj-x8nc", key: "bbl",
    verified: true, canaryField: "litigationid", bblField: "bbl", binField: "bin",
    orderBy: "caseopendate DESC",
    notes: "casestatus CLOSED/PENDING. casetype includes: Tenant Action, Heat and Hot Water, Elevator, etc. findingofharassment=YES is a strong adverse signal." },

  // HPD Fee Charges (cp6j-7bjj) — fees billed to owner for inspections, false certs, etc.
  // Keyed bbl + bin. Fields: feeid, feetype, feeamount, feeissueddate, doftransferdate.
  // Most fees are $200; watch for volume and unpaid (doftransferdate null = not yet liened).
  hpd_fee_charges: { slug: "hpd_fee_charges", socrataId: "cp6j-7bjj", key: "bbl",
    verified: true, canaryField: "feeid", bblField: "bbl", binField: "bin",
    orderBy: "feeissueddate DESC",
    notes: "feeamount usually $200. doftransferdate null = not yet transferred to DoF. feetype describes reason (e.g. Inspection Fee, False Cert Fee)." },

  // HPD Open Market Order Charges (mdbu-nrqn) — emergency repairs HPD performed and
  // billed back to the owner. Keyed bbl + bin.
  // Fields: omoid, omonumber, worktypegeneral, omoawardamount, omoawarddate, omocreatedate,
  // omostatusreason, isaep (Alternative Enforcement Program flag).
  hpd_omo_charges: { slug: "hpd_omo_charges", socrataId: "mdbu-nrqn", key: "bbl",
    verified: true, canaryField: "omoid", bblField: "bbl", binField: "bin",
    orderBy: "omocreatedate DESC",
    notes: "omoawardamount = cost HPD will lien against owner. isaep=Y means worst-in-class AEP building. worktypegeneral describes work type." },

  // HPD Handyman Work Order Charges (sbnd-xujn) — smaller-scale HPD-billed repairs.
  // Keyed bbl + bin. Fields: hwoid, worktypegeneral, hwoapprovedamount, chargeamount,
  // datetransferdof, hwocreatedate, adminfee, salestax.
  hpd_hwo_charges: { slug: "hpd_hwo_charges", socrataId: "sbnd-xujn", key: "bbl",
    verified: true, canaryField: "hwoid", bblField: "bbl", binField: "bin",
    orderBy: "hwocreatedate DESC",
    notes: "chargeamount = total lienable amount to DoF. hwoapprovedamount = labor+materials. datetransferdof null = not yet liened." },

  // NYC 311 Service Requests (erm2-nwe9) — all 311 complaints across all agencies,
  // keyed by bbl. NOTE: bbl is not populated on every row (older records, some
  // complaint types). Fields: unique_key, created_date, closed_date, agency,
  // agency_name, complaint_type, descriptor, status (Open/Closed),
  // resolution_description, incident_address.
  nyc_311: { slug: "nyc_311", socrataId: "erm2-nwe9", key: "bbl",
    verified: true, canaryField: "unique_key", bblField: "bbl",
    orderBy: "created_date DESC",
    notes: "All 311 complaints by BBL across all agencies (DOB, HPD, DEP, Sanitation, etc.). bbl null on some older rows. Fields: complaint_type, descriptor, agency, status, created_date, closed_date, resolution_description." },
};

export const BOROUGH_NAME: Record<number, string> = {
  1: "Manhattan", 2: "Bronx", 3: "Brooklyn", 4: "Queens", 5: "Staten Island",
};
export const ACRIS_BOROUGHS = new Set([1, 2, 3, 4]);

export function splitBBL(bbl: string): [number, number, number] {
  const b = String(bbl).trim();
  if (b.length !== 10 || !/^\d{10}$/.test(b)) throw new Error(`malformed BBL: ${bbl}`);
  return [Number(b[0]), Number(b.slice(1, 6)), Number(b.slice(6, 10))];
}
