import type { Config, Context } from "@netlify/functions";
import { autocomplete } from "../lib/geocode.ts";

export default async (req: Request, _ctx: Context) => {
  const q = new URL(req.url).searchParams.get("q") || "";
  try {
    const items = await autocomplete(q);
    return new Response(JSON.stringify(items), { headers: { "content-type": "application/json" } });
  } catch {
    return new Response("[]", { headers: { "content-type": "application/json" } });
  }
};

export const config: Config = { path: "/api/autocomplete" };
