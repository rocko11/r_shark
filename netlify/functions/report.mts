import type { Config, Context } from "@netlify/functions";
import { buildReport } from "../lib/report.ts";
import { resolve, nycPlaceMatches } from "../lib/geocode.ts";
import { detectRegion, townTail } from "../lib/region.ts";
import { buildNJReport, buildNJReportAt } from "../lib/nj.ts";
import { buildNYSReport, buildNYSReportAt, nysWhere } from "../lib/nys.ts";

// Successful reports are cached on Netlify's CDN (keyed by the full query string) for 6 h and
// served stale for up to a day while a fresh copy is fetched in the background, so re-opening
// a property or a shared link is instant. Errors / not-found are never cached.
const json = (body: any, status = 200) => {
  const ok = status === 200 && body && body.found !== false && !body.error;
  return new Response(JSON.stringify(body), {
    status, headers: {
      "content-type": "application/json",
      "cache-control": ok ? "public, max-age=300" : "no-store",
      ...(ok ? { "netlify-cdn-cache-control": "public, durable, s-maxage=21600, stale-while-revalidate=86400" } : {}),
    },
  });
};

// GET /api/report?address=...   or   /api/report?bbl=1234567890
export default async (req: Request, _ctx: Context) => {
  try {
    const url = new URL(req.url);
    const bin = url.searchParams.get("bin");
    const address = url.searchParams.get("address");

    // BBLs can arrive as a float string from PLUTO ("1010740014.00000000").
    // Strip any decimal and pad to 10 digits before validating.
    const rawBbl = url.searchParams.get("bbl");
    const bbl = rawBbl ? rawBbl.split(".")[0].padStart(10, "0") : null;

    // Map navigation outside NYC: ?nj_at=lat,lon or ?nys_at=lat,lon → the parcel at that point.
    const atParam = url.searchParams.get("nj_at") || url.searchParams.get("nys_at");
    if (atParam) {
      const [lat, lon] = atParam.split(",").map(Number);
      if (!(lat > 38 && lat < 46 && lon > -80.5 && lon < -71)) return json({ found: false, error: "Point out of range." }, 400);
      const rep: any = url.searchParams.get("nj_at") ? await buildNJReportAt(lat, lon) : await buildNYSReportAt(lat, lon);
      return json(rep, rep.found ? 200 : 404);
    }
    if (bbl) {
      if (!/^\d{10}$/.test(bbl)) return json({ found: false, error: "BBL must be 10 digits." }, 400);
      return json(await buildReport(bbl, bin));
    }
    if (address) {
      // Route by jurisdiction first: the NYC geocoders silently map out-of-city
      // addresses onto a same-named NYC street.
      const region = detectRegion(address);
      if (region === "nj") {
        const nj: any = await buildNJReport(address);
        return json(nj, nj.found ? 200 : 404);
      }
      if (region === "nys" || region === "check") {
        const where = await nysWhere(address);
        if (where && !where.inNYC) {
          const ny: any = await buildNYSReport(address, where);
          return json(ny, ny.found ? 200 : 404);
        }
        if (!where && !(region === "check" && await nycPlaceMatches(address, townTail(address)))) {
          return json({ found: false, region: "nys", error: "Couldn't find that address in New York State. Check the house number and town — for NYC addresses, include the borough (e.g. \"166 Carlton Ave, Brooklyn\")." }, 404);
        }
        // inside the five boroughs (or unknown "check") → continue with the NYC report
      }
      if (region === "other") {
        return json({ found: false, region, error: "That address is outside NYC and New Jersey, which R Shark doesn't cover yet." }, 422);
      }
      const cands = await resolve(address);
      if (!cands.length) return json({ found: false, error: "Could not resolve that address." }, 404);
      const top = cands[0];
      const rep: any = await buildReport(top.query_bbl, top.bin);
      rep.resolution = {
        chosen: top, other_candidates: cands.slice(1), ambiguous: cands.length > 1,
      };
      return json(rep);
    }
    return json({ found: false, error: "Pass ?address= or ?bbl=." }, 400);
  } catch (e) {
    // Always answer JSON; an HTML traceback becomes an opaque parse error client-side.
    return json({ found: false, error: `${(e as Error).name}: ${(e as Error).message}`.slice(0, 400) }, 500);
  }
};

export const config: Config = { path: "/api/report" };
