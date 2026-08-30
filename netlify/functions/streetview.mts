import type { Config, Context } from "@netlify/functions";

// GET /api/streetview?lat=..&lng=..  (or ?address=..)
// Returns a Google Street View photo for the property. The API key stays server-side:
// the browser never sees it. We first hit the FREE metadata endpoint to confirm real
// imagery exists at the spot (otherwise Google returns a generic gray image) and to
// get the capture date, then hand back a ready-to-use image URL plus that date.
//
// Env var: GOOGLE_MAPS_KEY (Street View Static API enabled).
export default async (req: Request, _ctx: Context) => {
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

  const key = process.env.GOOGLE_MAPS_KEY;
  if (!key) return json({ available: false, reason: "Street View not configured." });

  const u = new URL(req.url).searchParams;
  const lat = u.get("lat");
  const lng = u.get("lng");
  const address = u.get("address");
  const location = (lat && lng) ? `${lat},${lng}` : (address || "");
  if (!location) return json({ available: false, reason: "No location provided." });

  const base = "https://maps.googleapis.com/maps/api/streetview";
  const loc = encodeURIComponent(location);

  // 1) Metadata (free, no quota): does imagery exist? when was it taken?
  let meta: any = {};
  try {
    const r = await fetch(`${base}/metadata?location=${loc}&key=${key}`);
    meta = await r.json();
  } catch {
    return json({ available: false, reason: "Street View lookup failed." });
  }

  if (meta.status !== "OK") {
    return json({ available: false, reason: "No Street View imagery at this location.", status: meta.status });
  }

  // 2) Build the image URL.
  const size = "640x400";
  const fov = "80";
  const img = `${base}?size=${size}&location=${loc}&fov=${fov}&return_error_code=true&key=${key}`;

  // meta.date is "YYYY-MM" - format friendly.
  let captured: string | null = null;
  if (typeof meta.date === "string" && /^\d{4}-\d{2}/.test(meta.date)) {
    const [y, m] = meta.date.split("-");
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    captured = `${months[Number(m) - 1] || m} ${y}`;
  }

  return json({
    available: true,
    image_url: img,
    captured,
    copyright: meta.copyright || "(c) Google",
  });
};

export const config: Config = { path: "/api/streetview" };
