// Owner skip-trace via DataSkip (paid, per-match). This is the ONLY part of the app
// that costs money per call, so it is:
//   - gated behind the SKIPTRACE_API_KEY env var (absent key => feature simply off),
//   - fired ON DEMAND from a dedicated endpoint (/api/skiptrace), never automatically
//     on every report, so the user is not billed for lookups they didn't ask for,
//   - honest about misses: DataSkip refunds non-matches automatically (net cost is
//     matches only), and we surface a miss plainly rather than inventing a result.
//
// DataSkip single lookup (from their live API docs):
//   POST https://app.dataskip.io/api/v1/skip-trace
//   Header: Authorization: Bearer <key>
//   Body:   { address, city, state, zip }
//   Resp:   { success, found, charged,
//             contact: { firstName, lastName, fullName,
//                        propertyAddress/City/State/Zip,
//                        mailingAddress/City/State/Zip },
//             phones: [ { number, type, dnc } ],
//             emails: [ "..." ] }

const ENDPOINT = "https://app.dataskip.io/api/v1/skip-trace";

type Phone = { number: string; type?: string; dnc?: boolean };
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
      source: "DataSkip";
    }
  | { enabled: true; error: string };

export async function skipTraceOwner(input: {
  address: string; city?: string; state?: string; zip?: string;
}): Promise<SkipResult> {
  const key = process.env.SKIPTRACE_API_KEY;
  if (!key) return { enabled: false };

  const body = {
    address: input.address,
    city: input.city || "",
    state: input.state || "NY",
    zip: input.zip || "",
  };

  let data: any;
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return { enabled: true, error: `DataSkip ${r.status}: ${t.slice(0, 160)}` };
    }
    data = await r.json();
  } catch (e) {
    return { enabled: true, error: `DataSkip request failed: ${(e as Error).message}`.slice(0, 200) };
  }

  const found = data?.found === true;
  const charged = Number(data?.charged) || 0;

  if (!found) {
    return {
      enabled: true, hit: false, credits_deducted: charged,
      note: "No match found. DataSkip refunds non-matches automatically, so a miss costs nothing. Not every owner (especially LLCs with no individual on record) can be skip-traced.",
    };
  }

  const c = data.contact || {};

  const phones: Phone[] = (Array.isArray(data.phones) ? data.phones : []).slice(0, 8).map((p) => {
    if (typeof p === "string") return { number: p };
    return {
      number: String(p.number || p.phone || "").trim(),
      type: p.type || undefined,
      dnc: p.dnc === true,
    };
  }).filter((p) => p.number);

  const emails: string[] = (Array.isArray(data.emails) ? data.emails : [])
    .map((e) => (typeof e === "string" ? e : e.email || e.address || ""))
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 5);

  const mailing = [
    c.mailingAddress, c.mailingCity,
    [c.mailingState, c.mailingZip].filter(Boolean).join(" "),
  ].filter(Boolean).join(", ") || null;

  const ownerName = c.fullName || [c.firstName, c.lastName].filter(Boolean).join(" ") || null;

  return {
    enabled: true, hit: true, credits_deducted: charged,
    owner_name: ownerName,
    phones, emails,
    mailing_address: mailing,
    source: "DataSkip",
    compliance_note:
      "Skip-traced contact data. Numbers flagged DNC are on a Do-Not-Call registry - do not dial those. You are responsible for TCPA/DNC compliance on any outreach.",
  };
}
