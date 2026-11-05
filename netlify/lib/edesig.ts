// (E) designations: the full requirement set for a lot, before underwriting.
//
// An (E) is placed on a lot by a rezoning's environmental review (CEQR). It doesn't stop the
// current use, but DOB won't issue permits for new construction, an enlargement, a change of use
// or (for hazardous materials) work that disturbs soil until the NYC Office of Environmental
// Remediation (OER) signs off — and OER must sign off again before a Certificate of Occupancy.
//
// Sources: DCP E-designations (data.cityofnewyork.us hxm3-23vy, by BBL) for what was imposed;
// OER project list (3279-pp7v) for whether anyone has enrolled the lot with OER and how far along it is.

const OER = "https://data.cityofnewyork.us/resource/3279-pp7v.json";

export interface Requirement { key: string; category: "Hazardous materials" | "Air quality" | "Noise" | "Other";
  title: string; what: string; deliverables: string[]; signoff: string; underwriting: string; source_text: string }

type Lib = { re: RegExp; make: (txt: string) => Omit<Requirement, "source_text"> };
const HAZ_SIGNOFF = "OER issues a Notice to Proceed / Notice of No Objection so DOB can issue permits, then a Notice of Satisfaction after cleanup — DOB needs that before any TCO or CO.";
const DESIGN_SIGNOFF = "OER reviews the design and issues a Notice of No Objection before DOB permits, then a Notice of Satisfaction (based on the as-built) before any TCO or CO.";
const LIB: Lib[] = [
  { re: /Hazardous Materials/i, make: () => ({ key: "hazmat", category: "Hazardous materials",
    title: "Hazardous materials — Phase I and Phase II testing protocol",
    what: "Before DOB permits for new construction, an enlargement, a change of use or any soil disturbance, the site must be investigated for contamination and cleaned up to OER's standards.",
    deliverables: [
      "Enroll the project with OER (EPIC portal)",
      "Phase I Environmental Site Assessment",
      "Phase II / Remedial Investigation Work Plan — sampling plan approved by OER before any testing",
      "Remedial Investigation Report with soil, groundwater and soil-vapor results",
      "Remedial Action Work Plan and Construction Health & Safety Plan, if contamination is found",
      "Remedial Closure Report after the work (disposal manifests, end-point samples, any vapor barrier or sub-slab system)",
    ],
    signoff: HAZ_SIGNOFF,
    underwriting: "Budget time and money for testing before closing if you can, then excavation, soil disposal, and possibly a vapor barrier or sub-slab depressurization. OER's Voluntary Cleanup Program and the NYC Brownfield Incentive Grant can offset costs." }) },
  { re: /Underground Gasoline Storage Tanks/i, make: () => ({ key: "ust", category: "Hazardous materials",
    title: "Underground gasoline storage tanks — testing protocol",
    what: "The lot is suspected of having (or having had) gasoline tanks. Tanks and the surrounding soil and groundwater must be tested and dealt with before DOB permits.",
    deliverables: [
      "Enroll the project with OER (EPIC portal)",
      "Tank survey and testing plan approved by OER",
      "Tank closure or removal under NYS DEC petroleum bulk storage rules, with any spill reported to DEC",
      "Soil and groundwater sampling report; remediation plan if petroleum is found",
      "Closure report to OER",
    ],
    signoff: HAZ_SIGNOFF,
    underwriting: "Tank removal and petroleum-impacted soil can be a large, uncertain cost. Ask the seller for tank records and any DEC spill numbers, and price a contingency." }) },
  { re: /Window[- ]Wall Attenuation|Double Glazed Windows/i, make: (t) => ({ key: "noise", category: "Noise",
    title: /Double Glazed/i.test(t) ? "Noise — double-glazed windows" + (/Alternate Ventilation/i.test(t) ? " and alternate ventilation" : "") : "Noise — window-wall attenuation and alternate ventilation",
    what: "Residential and other sensitive spaces must reach the composite window-wall noise reduction (in dBA) set in the rezoning's CEQR review, with a way to ventilate the space with the windows closed.",
    deliverables: [
      "Find the required attenuation level (typically 28–40 dBA) in the CEQR document for this (E) number",
      "Acoustical design: window and wall assemblies with tested STC/OITC ratings that meet the level",
      "Alternate ventilation (central air, PTACs or through-wall units) so windows can stay shut",
      "Drawings and specifications submitted to OER; as-built confirmation before CO",
    ],
    signoff: DESIGN_SIGNOFF,
    underwriting: "Usually a construction-cost item, not a deal-killer: higher-rated windows and mechanical ventilation. The higher the dBA level, the pricier the facade." }) },
  { re: /Con Edison steam only/i, make: () => ({ key: "steam", category: "Air quality",
    title: "Air quality — Con Edison steam only",
    what: "Heating and hot water must come from Con Edison steam; no on-site fuel-burning boilers.",
    deliverables: ["Mechanical plans showing steam service and no combustion equipment", "Submission to OER for review"],
    signoff: DESIGN_SIGNOFF, underwriting: "Confirm steam service is available at the block and price the connection and ongoing steam costs." }) },
  { re: /low Nox/i, make: () => ({ key: "lownox", category: "Air quality",
    title: "Air quality — natural gas with low-NOx burners only",
    what: "Heating, hot water and HVAC equipment must burn natural gas only, using low-NOx burners.",
    deliverables: ["Mechanical plans and equipment cut sheets showing natural gas, low-NOx burners", "Submission to OER for review"],
    signoff: DESIGN_SIGNOFF, underwriting: "Small cost premium on boilers. All-electric (heat pumps) generally avoids fuel limits, but confirm with OER." }) },
  { re: /HVAC fuel limited to natural gas|Natural Gas Heat|Natural Gas for HVAC/i, make: (t) => ({ key: "fuel", category: "Air quality",
    title: /#2|#4/.test(t) ? "Air quality — fuel type limited (" + t.replace(/^Air Quality\s*-\s*/i, "") + ")" : "Air quality — heating, hot water and HVAC fuel limited to natural gas",
    what: /#2|#4/.test(t) ? "Fuel-burning equipment may use only the fuels named here." : "Fuel-burning heating, hot water and HVAC equipment must use natural gas only.",
    deliverables: ["Mechanical plans and equipment specs showing the permitted fuel", "Submission to OER for review"],
    signoff: DESIGN_SIGNOFF, underwriting: "Low cost impact for most new buildings. All-electric systems generally avoid fuel limits, but confirm with OER." }) },
  { re: /#2 Fuel Oil|#4 Fuel Oil/i, make: (t) => ({ key: "fueloil", category: "Air quality",
    title: "Air quality — fuel type limited (" + t.replace(/^Air Quality\s*-\s*/i, "") + ")",
    what: "Fuel-burning equipment may use only the fuels named here.",
    deliverables: ["Mechanical plans and equipment specs showing the permitted fuel", "Submission to OER for review"],
    signoff: DESIGN_SIGNOFF, underwriting: "Low cost impact; confirm the planned mechanical system complies." }) },
  { re: /Exhaust stack location/i, make: () => ({ key: "stack", category: "Air quality",
    title: "Air quality — exhaust stack location limits",
    what: "Boiler or HVAC exhaust stacks must meet the minimum height and distance from lot lines or neighbouring buildings set in the CEQR review.",
    deliverables: ["Find the stack height / setback in the CEQR document for this (E) number", "Roof and mechanical plans showing the stack location", "Submission to OER for review"],
    signoff: DESIGN_SIGNOFF, underwriting: "Can constrain roof layout or require a taller stack; check it against your massing early." }) },
];

export function parseRequirements(description: string | null | undefined): Requirement[] {
  const parts = String(description || "").split(/;/).map(s => s.trim()).filter(s => s && !/^none$/i.test(s));
  const out: Requirement[] = [];
  for (const p of parts) {
    const hit = LIB.find(l => l.re.test(p));
    const r = hit ? { ...hit.make(p), source_text: p } : {
      key: "other", category: "Other" as const, title: p, source_text: p,
      what: "Requirement as listed on the (E) designation. The CEQR document for this (E) number spells out the details.",
      deliverables: ["Read the CEQR document for this (E) number", "Submit plans to OER for review"], signoff: DESIGN_SIGNOFF, underwriting: "Confirm scope and cost with your environmental consultant." };
    if (!out.some(o => o.key === r.key && o.title === r.title)) out.push(r);
  }
  return out;
}

const yes = (v: any) => v === true || v === "true";
export async function fetchOerProjects(bbl: string) {
  const u = `${OER}?$where=${encodeURIComponent(`bbl like '%${bbl.replace(/\D/g, "")}%'`)}&$limit=20`;
  let r = await fetch(u, { signal: AbortSignal.timeout(9000) }).catch(() => null);
  if (!r || !r.ok) r = await fetch(u, { signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error(`OER ${r.status}`);
  const rows: any[] = await r.json();
  return rows.map(x => ({
    name: x.project_name || null, numbers: x.oer_project_numbers || null, program: x.oer_program || null,
    phase: x.phase || null, class: x.class || null, documents: x.project_specific_document?.url || null,
    restrictive_declaration: /RD/.test(String(x.oer_program || "")),
  }));
}

export function buildERequirements(rows: any[] | null | undefined, oer: any[] | null, oerFailed?: string) {
  const list = (rows || []).filter(e => e && (e.enumber || e.e_number));
  if (!list.length) return { has_e: false, designations: [], oer: oer || [], oer_failed: oerFailed || null };
  const designations = list.map(e => {
    const requirements = parseRequirements(e.description);
    return {
      enumber: e.enumber || e.e_number, effective_date: e.effective_date ? String(e.effective_date).slice(0, 10) : null,
      ceqr_number: e.ceqr_num || null, ulurp_number: e.ulurp_num || null,
      hazmat: yes(e.hazmat_code), air: yes(e.air_code), noise: yes(e.noise_code),
      description: e.description || null, requirements,
    };
  });
  const all = designations.flatMap(d => d.requirements);
  const has = (c: string) => all.some(r => r.category === c);
  const enrolled = (oer || []).length > 0;
  const satisfied = (oer || []).some(p => /complete|satisf/i.test(`${p.phase} ${p.class}`));
  const steps = [
    { step: "Enroll the lot with OER", detail: "Create the project in OER's EPIC portal; OER assigns a project number and a reviewer." },
    ...(has("Hazardous materials") ? [
      { step: "Investigate", detail: "Phase I, then an OER-approved Phase II / Remedial Investigation Work Plan and the sampling itself." },
      { step: "Plan the cleanup", detail: "Remedial Action Work Plan and Construction Health & Safety Plan approved by OER." },
    ] : []),
    ...(has("Noise") || has("Air quality") || has("Other") ? [
      { step: "Submit the design", detail: "Send OER the " + ([has("Noise") && "window-wall attenuation and ventilation", has("Air quality") && "fuel and exhaust stack", has("Other") && "required"].filter(Boolean).join(", ")) + " drawings." },
    ] : []),
    { step: "Get the permit sign-off", detail: "OER's Notice to Proceed / Notice of No Objection lets DOB issue permits." },
    ...(has("Hazardous materials") ? [{ step: "Clean up and close out", detail: "Do the remediation during construction and file the Remedial Closure Report." }] : []),
    { step: "Get the Notice of Satisfaction", detail: "Needed before DOB issues a TCO or CO." },
  ];
  const headline = `${designations.length} (E) designation${designations.length > 1 ? "s" : ""} on this lot: ${[has("Hazardous materials") && "hazardous materials", has("Air quality") && "air quality", has("Noise") && "noise", has("Other") && "other"].filter(Boolean).join(", ")}. ` +
    (satisfied ? "OER records show a completed project here — confirm it covers your planned work." : enrolled ? "An OER project already exists for this lot — check its status before you close." : "No OER project on file yet — you will need to enroll and get sign-off before permits.");
  return { has_e: true, headline, designations, requirements: all, oer: oer || [], oer_failed: oerFailed || null, oer_enrolled: enrolled, oer_satisfied: satisfied, steps,
    links: { epic: "https://a002-epic.nyc.gov/", ceqr_access: "https://a002-ceqraccess.nyc.gov/ceqr/", zap: "https://zap.planning.nyc.gov/projects", oer: "https://www.nyc.gov/site/oer/index.page" } };
}
