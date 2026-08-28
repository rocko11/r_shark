import type { Config, Context } from "@netlify/functions";
import { DATASETS } from "../lib/datasets.ts";
import * as sq from "../lib/socrata.ts";

// $select one known field from each dataset. A 400 means the schema moved.
// Run on a schedule (Netlify scheduled functions) and alert on failures.
export default async (_req: Request, _ctx: Context) => {
  const slugs = Object.keys(DATASETS);
  const results = await Promise.all(slugs.map(async (slug) => {
    const ds = DATASETS[slug];
    try {
      await sq.query(ds, { select: ds.canaryField, limit: 1 });
      return [slug, null] as const;
    } catch (e) {
      return [slug, String(e).slice(0, 200)] as const;
    }
  }));
  const failures: Record<string, string> = {};
  for (const [slug, err] of results) if (err) failures[slug] = err;

  return new Response(
    JSON.stringify({ ok: Object.keys(failures).length === 0, checked: slugs.length, failures }, null, 2),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = { path: "/api/canary" };
