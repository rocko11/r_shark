import type { Config, Context } from "@netlify/functions";

// POST /api/skiptrace-bulk
// Body: { addresses: [{ address, city, state, zip, bbl }] }
// Calls DataSkip once per address (their API is single-lookup only, no batch endpoint).
// Returns results keyed by bbl. Capped at 50 addresses per call.

const ENDPOINT = "https://app.dataskip.io/api/v1/skip-trace";

type Phone = { number: string; type?: string; dnc?: boolean; carrier?: string; litigator?: boolean };

async function skipTraceOwner(key: string, input: { address: string; city?: string; state?: string; zip?: string }) {
  const body = { address: input.address, city: input.city || "", state: input.state || "NY", zip: input.zip || "" };
  let data: any;
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return { hit: false as const, error: `DataSkip ${r.status}: ${t.slice(0, 120)}` };
    }
    data = await r.json();
  } catch (e) {
    return { hit: false as const, error: `Request failed: ${(e as Error).message}`.slice(0, 200) };
  }

  if (!data?.found) {
    return { hit: false as const, credits_deducted: Number(data?.charged) || 0 };
  }

  const c = data.contact || {};
  const phones: Phone[] = (Array.isArray(data.phones) ? data.phones : []).slice(0, 6).map((p: any) => ({
    number: String(p.number || p.phone || "").trim(),
    type: p.type || undefined,
    dnc: p.dnc === true,
    carrier: p.carrier || undefined,
    litigator: p.litigator === true,
  })).filter((p: Phone) => p.number);

  const emails: string[] = (Array.isArray(data.emails) ? data.emails : [])
    .map((e: any) => (typeof e === "string" ? e : e.email || ""))
    .map((s: string) => s.trim()).filter(Boolean).slice(0, 4);

  const mailing = [c.mailingAddress, c.mailingCity, [c.mailingState, c.mailingZip].filter(Boolean).join(" ")]
    .filter(Boolean).join(", ") || null;

  return {
    hit: true as const,
    credits_deducted: Number(data.charged) || 0,
    owner_name: c.fullName || [c.firstName, c.lastName].filter(Boolean).join(" ") || null,
    phones, emails,
    mailing_address: mailing,
  };
}

export default async (req: Request, _ctx: Context) => {
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const apiKey = process.env.SKIPTRACE_API_KEY;
  if (!apiKey) return json({ enabled: false }, 200);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }

  const addresses: { address: string; city?: string; state?: string; zip?: string; bbl: string }[] =
    Array.isArray(body.addresses) ? body.addresses.slice(0, 50) : [];

  if (!addresses.length) return json({ error: "addresses array required" }, 400);

  const results: Record<string, any> = {};
  let total_cost = 0;

  for (const item of addresses) {
    const key_id = item.bbl || item.address;
    const r = await skipTraceOwner(apiKey, { address: item.address, city: item.city || "New York", state: "NY", zip: item.zip || "" });
    results[key_id] = r;
    if ("credits_deducted" in r) total_cost += r.credits_deducted || 0;
    await new Promise(res => setTimeout(res, 120)); // rate-limit buffer
  }

  return json({ enabled: true, results, total_cost, count: addresses.length });
};

export const config: Config = { path: "/api/skiptrace-bulk" };
