import type { Config, Context } from "@netlify/functions";
import { buildReport } from "../lib/report.ts";
import { resolve } from "../lib/geocode.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });

// GET /api/report?address=...   or   /api/report?bbl=1234567890
export default async (req: Request, _ctx: Context) => {
  try {
    const url = new URL(req.url);
    const bbl = url.searchParams.get("bbl");
    const bin = url.searchParams.get("bin");
    const address = url.searchParams.get("address");

    if (bbl) {
      if (!/^\d{10}$/.test(bbl)) return json({ found: false, error: "BBL must be 10 digits." }, 400);
      return json(await buildReport(bbl, bin));
    }
    if (address) {
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
