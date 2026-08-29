// Owner skip-trace via Tracerfy (paid, per-hit). This is the ONLY part of the app
// that costs money per call, so it is:
//   - gated behind the TRACERFY_API_KEY env var (absent key => feature simply off),
//   - fired ON DEMAND from a dedicated endpoint (/api/skiptrace), never automatically
//     on every report, so the user is not billed for lookups they didn't ask for,
//   - honest about misses: Tracerfy charges nothing on a miss ("hit": false), and we
//     surface that plainly rather than pretending we found something.
//
// Tracerfy instant lookup:
//   POST https://www.tracerfy.com/v1/api/lead-builder/lookup/
//   Header: Authorization: Api-Key <key>
//   Body:   { address, city, state, zip_code }
//   Resp:   { hit, credits_deducted, skip_trace_hit, property:{...}, owner/contacts... }
//
// NOTE: response field shapes below are mapped defensively — Tracerfy returns 50+
// fields and the exact nesting can vary, so we probe several likely locations for
// phones/emails/mailing and degrade gracefully if the shape differs.

const ENDPOINT = "https://www.tracerfy.com/v1/api/lead-builder/lookup/";

type Phone = { number: string; type?: string; carrier?: string; dnc?: boolean; litigator?: boolean };
type SkipResult =
  | { enabled: false }
  | { enabled: true; hit: false; credits_deducted: number; note: string }
  | {
      enabled: true; hit: true; credits_deducted: number;
      owner_name?: string | null;
      phones: Phone[];
      emails: string[];
      mailing_address?: string | null;
      compliance_note: string;
      source: "Tracerfy";
    }
  | { enabled: true; error: string };

function pickArray(obj: any, keys: string[]): any[] {
  for (const k of keys) {
    const v = obj?.[k];
    if (Array.isArray(v) && v.length) return v;
  }
  return [];
}

export async function skipTraceOwner(input: {
  address: string; city?: string; state?: string; zip?: string;
}): Promise<SkipResult> {
  const key = process.env.TRACERFY_API_KEY;
  if (!key) return { enabled: false };

  const body = {
    address: input.address,
    city: input.city || "",
    state: input.state || "NY",
    zip_code: input.zip || "",
  };

  let data: any;
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Authorization": `Api-Key ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return { enabled: true, error: `Tracerfy ${r.status}: ${t.slice(0, 160)}` };
    }
    data = await r.json();
  } catch (e) {
    return { enabled: true, error: `Tracerfy request failed: ${(e as Error).message}`.slice(0, 200) };
  }

  const hit = data?.hit === true || data?.skip_trace_hit === true;
  const credits = Number(data?.credits_deducted) || 0;

  if (!hit) {
    return {
      enabled: true, hit: false, credits_deducted: credits,
      note: "No match found. Tracerfy doesn't charge for a miss — no credits were used. Not every owner (especially LLCs with no individual on record) can be skip-traced.",
    };
  }

  // Probe likely locations for the contact fields.
  const ownerObj = data.owner || data.contact || data.person || data;
  const rawPhones = pickArray(data, ["phones", "phone_numbers"]).concat(pickArray(ownerObj, ["phones", "phone_numbers"]));
  const rawEmails = pickArray(data, ["emails", "email_addresses"]).concat(pickArray(ownerObj, ["emails", "email_addresses"]));

  const phones: Phone[] = rawPhones.slice(0, 8).map((p: any) => {
    if (typeof p === "string") return { number: p };
    return {
      number: String(p.number || p.phone || p.value || "").trim(),
      type: p.type || p.phone_type || undefined,
      carrier: p.carrier || undefined,
      dnc: p.dnc === true || p.is_dnc === true,
      litigator: p.litigator === true || p.tcpa_litigator === true,
    };
  }).filter((p) => p.number);

  const emails: string[] = rawEmails.slice(0, 5)
    .map((e: any) => (typeof e === "string" ? e : e.email || e.address || e.value || ""))
    .map((s: string) => String(s).trim()).filter(Boolean);

  const mailing =
    data.mailing_address || ownerObj.mailing_address ||
    [ownerObj.mailing_street || ownerObj.mail_street, ownerObj.mailing_city || ownerObj.mail_city,
     ownerObj.mailing_state || ownerObj.mail_state, ownerObj.mailing_zip || ownerObj.mail_zip]
      .filter(Boolean).join(", ") || null;

  const ownerName = ownerObj.name || ownerObj.owner_name ||
    [ownerObj.first_name, ownerObj.last_name].filter(Boolean).join(" ") || data.owner_name || null;

  const anyDnc = phones.some((p) => p.dnc);
  const anyLit = phones.some((p) => p.litigator);

  return {
    enabled: true, hit: true, credits_deducted: credits,
    owner_name: ownerName,
    phones, emails,
    mailing_address: mailing,
    source: "Tracerfy",
    compliance_note:
      "Skip-traced contact data. Before calling: numbers flagged DNC are on a Do-Not-Call registry and TCPA-litigator flags mark known plaintiffs — do not dial those. You are responsible for TCPA/DNC compliance on any outreach.",
  };
}
