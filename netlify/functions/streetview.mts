import type { Config, Context } from "@netlify/functions";

// GET /api/streetview?lat=..&lng=..            -> JSON {available, captured, ...} (metadata only)
// GET /api/streetview?lat=..&lng=..&img=1      -> the actual JPEG bytes, proxied server-side
//
// The API key NEVER reaches the browser: we check the free metadata endpoint for imagery +
// capture date, and when the frontend needs the picture it requests ?img=1 and we fetch the
// Street View Static image server-side and stream the bytes back from our own domain. That
// also sidesteps HTTP-referrer key restrictions (the browser's referrer is our site, and the
// Google request is made by Netlify with the key held only on the server).
//
// Env var: GOOGLE_MAPS_KEY (Street View Static API enabled + billing).
const BASE = "https://maps.googleapis.com/maps/api/streetview";

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
  const loc = encodeURIComponent(location);

  // --- Image mode: fetch the JPEG server-side and stream the bytes back. ---
  if (u.get("img")) {
    const imgUrl = `${BASE}?size=640x400&location=${loc}&fov=80&return_error_code=true&key=${key}`;
    try {
      const r = await fetch(imgUrl);
      if (!r.ok) {
        return new Response(`Street View image error ${r.status}`, { status: r.status });
      }
      const buf = await r.arrayBuffer();
      return new Response(buf, {
        status: 200,
        headers: {
          "content-type": r.headers.get("content-type") || "image/jpeg",
          "cache-control": "public, max-age=86400",
        },
      });
    } catch (e) {
      return new Response(`Street View fetch failed`, { status: 502 });
    }
  }

  // --- Metadata mode (default): does imagery exist? when was it taken? (free, no quota) ---
  let meta: any = {};
  try {
    const r = await fetch(`${BASE}/metadata?location=${loc}&key=${key}`);
    meta = await r.json();
  } catch {
    return json({ available: false, reason: "Street View lookup failed." });
  }

  if (meta.status !== "OK") {
    return json({ available: false, reason: "No Street View imagery at this location.", status: meta.status });
  }

  let captured: string | null = null;
  if (typeof meta.date === "string" && /^\d{4}-\d{2}/.test(meta.date)) {
    const [y, m] = meta.date.split("-");
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    captured = `${months[Number(m) - 1] || m} ${y}`;
  }

  // Hand back a same-origin image URL (no key) that the browser loads via the img proxy above.
  const proxyUrl = `/api/streetview?${lat && lng ? `lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}` : `address=${loc}`}&img=1`;

  return json({
    available: true,
    image_url: proxyUrl,
    captured,
    copyright: meta.copyright || "(c) Google",
  });
};

export const config: Config = { path: "/api/streetview" };
