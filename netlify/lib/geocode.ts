// Address -> BBL/BIN. Returns a candidate list, never a silent single guess.
// Corner lots, mid-subdivision lots, and condo units all mislead a naive resolve.

const GEOCLIENT_URL = "https://api.nyc.gov/geoclient/v2/search";
const GEOSEARCH_URL = "https://geosearch.planninglabs.nyc/v2/search";
const GEOSEARCH_AC = "https://geosearch.planninglabs.nyc/v2/autocomplete";

// NYC API Developers Portal -> "Geoclient User" -> subscribe to Geoclient v2.
const GEOCLIENT_KEY = process.env.GEOCLIENT_SUBSCRIPTION_KEY || "";

export interface Candidate {
  bbl: string; bin: string | null; address: string; borough: string;
  billing_bbl: string | null; is_condo_unit: boolean;
  latitude: number | null; longitude: number | null;
  source: string; confidence: number; query_bbl: string;
}

function cleanBBL(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  return (s.length === 10 && /^\d{10}$/.test(s) && s !== "0000000000") ? s : null;
}

function queryBBL(c: Omit<Candidate, "query_bbl">): string {
  return c.is_condo_unit && c.billing_bbl ? c.billing_bbl : c.bbl;
}

function fromGeoclient(payload: any): Candidate[] {
  const out: Candidate[] = [];
  for (const item of payload?.results ?? []) {
    const resp = item?.response ?? {};
    const bbl = cleanBBL(resp.bbl);
    if (!bbl) continue;
    const billing = cleanBBL(resp.condominiumBillingBbl);
    const isCondo = !!(billing && billing !== bbl);
    const addr = [resp.houseNumber, resp.firstStreetNameNormalized || resp.streetName1In]
      .filter(Boolean).join(" ").trim();
    const base = {
      bbl, bin: resp.buildingIdentificationNumber || null,
      address: addr || payload.input || "", borough: resp.firstBoroughName || "",
      billing_bbl: billing, is_condo_unit: isCondo,
      latitude: resp.latitude ? Number(resp.latitude) : null,
      longitude: resp.longitude ? Number(resp.longitude) : null,
      source: "geoclient",
      confidence: (item.level === "1" || item.level === 1) ? 0.95 : 0.75,
    };
    out.push({ ...base, query_bbl: queryBBL(base) });
  }
  return out;
}

function fromGeoSearch(payload: any): Candidate[] {
  const out: Candidate[] = [];
  for (const feat of payload?.features ?? []) {
    const props = feat?.properties ?? {};
    const pad = props?.addendum?.pad ?? {};
    const bbl = cleanBBL(pad.bbl);
    if (!bbl) continue;
    const coords = feat?.geometry?.coordinates ?? [null, null];
    const base = {
      bbl, bin: pad.bin || null, address: props.label || props.name || "",
      borough: props.borough || "", billing_bbl: null, is_condo_unit: false,
      latitude: coords[1], longitude: coords[0], source: "geosearch",
      confidence: Math.min(0.9, Number(props.confidence) || 0.6),
    };
    out.push({ ...base, query_bbl: queryBBL(base) });
  }
  return out;
}

async function timedFetch(url: string, init: RequestInit, ms = 9000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

export async function resolve(address: string, limit = 5): Promise<Candidate[]> {
  address = address.trim();
  if (!address) return [];

  if (GEOCLIENT_KEY) {
    try {
      const u = `${GEOCLIENT_URL}?input=${encodeURIComponent(address)}`;
      const r = await timedFetch(u, { headers: { "Ocp-Apim-Subscription-Key": GEOCLIENT_KEY } });
      if (r.ok) {
        const cands = fromGeoclient(await r.json());
        if (cands.length) return cands.slice(0, limit);
      }
    } catch { /* fall through to GeoSearch */ }
  }

  const u = `${GEOSEARCH_URL}?text=${encodeURIComponent(address)}&size=${limit}`;
  const r = await timedFetch(u, {});
  if (!r.ok) throw new Error(`geosearch HTTP ${r.status}`);
  return fromGeoSearch(await r.json()).slice(0, limit);
}

export async function autocomplete(text: string, size = 8) {
  if (text.trim().length < 3) return [];
  const u = `${GEOSEARCH_AC}?text=${encodeURIComponent(text)}&size=${size}`;
  const r = await timedFetch(u, {}, 6000);
  if (!r.ok) return [];
  const j = await r.json();
  return (j.features ?? []).map((f: any) => ({
    label: f?.properties?.label,
    bbl: f?.properties?.addendum?.pad?.bbl ?? null,
  }));
}
