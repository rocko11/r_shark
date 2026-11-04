import type { Config, Context } from "@netlify/functions";
import { gate } from "../lib/access.ts";
import { autocomplete } from "../lib/geocode.ts";
import { detectRegion } from "../lib/region.ts";
import { njSuggest } from "../lib/nj.ts";

export default async (req: Request, _ctx: Context) => {
  const __ent = await gate(req, "basic", { preview: true }); if (__ent instanceof Response) return __ent;
  const q = new URL(req.url).searchParams.get("q") || "";
  try {
    const region = detectRegion(q);
    const items = region === "nj" ? await njSuggest(q) : (region === "nyc" || region === "check") ? await autocomplete(q) : [];
    return new Response(JSON.stringify(items), { headers: { "content-type": "application/json" } });
  } catch {
    return new Response("[]", { headers: { "content-type": "application/json" } });
  }
};

export const config: Config = { path: "/api/autocomplete" };
