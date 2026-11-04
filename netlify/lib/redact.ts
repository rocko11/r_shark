// Free preview: signed-in users without a plan get the full report *shape* — every section, row and
// chart — but with the actual facts scrambled server-side. The page blurs it on top. Blurring alone
// isn't enough: the real JSON would still be readable in the browser's dev tools.
//
// Kept as-is: what the page needs to draw the layout and the map (address of the property the user
// typed, BBL / lot ids for navigation, coordinates and parcel shapes, short lowercase enum codes such
// as "critical" / "residence" / "revocable"). Everything else — names, amounts, dates, counts, zoning
// numbers, text — is replaced with same-length filler or a plausible-looking scrambled number.

const KEEP_KEYS = new Set([
  "found", "region", "bbl", "query_bbl", "bin", "generated_at", "locked",
  "latitude", "longitude", "lat", "lon", "lng", "x", "y", "centroid", "rings", "geometry", "coordinates", "paths", "point",
  "borough", "block", "lot", "is_self",
]);
// Paths (dot-joined, array indexes dropped) whose values stay readable.
const KEEP_PATHS = new Set([
  "identity.address", "identity.borough", "identity.zip", "identity.block", "identity.lot", "identity.latitude", "identity.longitude",
  "parcel.address", "parcel.municipality", "parcel.county", "parcel.zip", "parcel.city_town",
  "geocode.matched", "geocode.lat", "geocode.lon", "point",
]);

function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed: number) { let x = seed || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 10000) / 10000; }; }

function maskString(s: string, seed: number): string {
  if (/^[a-z][a-z0-9_ -]{0,23}$/.test(s)) return s;                 // enum-like codes the UI switches on
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return "2000-01-01" + s.slice(10).replace(/\d/g, "0"); // dates: valid but meaningless
  if (/^https?:\/\//.test(s)) return "#";
  const r = rng(seed);
  return s.replace(/[A-Z]/g, () => String.fromCharCode(65 + Math.floor(r() * 26)))
          .replace(/[a-z]/g, () => String.fromCharCode(97 + Math.floor(r() * 26)))
          .replace(/\d/g, () => String(Math.floor(r() * 10)));
}
function maskNumber(n: number, seed: number): number {
  if (!Number.isFinite(n) || n === 0) return n;
  const r = rng(seed)();
  const v = n * (0.35 + r * 1.3);                                   // same order of magnitude, wrong value
  return Number.isInteger(n) ? Math.round(v) : Math.round(v * 100) / 100;
}

export function redact(value: any, path = "", seed = 7): any {
  if (value === null || value === undefined || typeof value === "boolean") return value;
  const key = path.split(".").pop() || "";
  if (KEEP_PATHS.has(path) || KEEP_KEYS.has(key)) return value;
  const s = seed ^ hash(path);
  if (Array.isArray(value)) return value.map((v, i) => redact(v, path, s + i * 7919));
  if (typeof value === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, path ? `${path}.${k}` : k, s);
    return out;
  }
  if (typeof value === "number") return maskNumber(value, s);
  if (typeof value === "string") return maskString(value, s);
  return value;
}

// Wrap a JSON Response: scramble it for preview users and mark it locked.
export async function redactResponse(res: Response): Promise<Response> {
  if (!(res.headers.get("content-type") || "").includes("json")) return res;
  const body = await res.json().catch(() => null);
  if (body === null) return res;
  const out = Array.isArray(body) ? redact(body) : { ...redact(body), locked: true };
  return new Response(JSON.stringify(out), { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
