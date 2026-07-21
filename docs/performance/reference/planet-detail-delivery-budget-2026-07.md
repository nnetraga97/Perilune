# Planet detail delivery budget — July 2026

The Medium and High logical GPU ceilings remain 32 MiB and 64 MiB. The current
bounded implementation can keep at most one 3x3 compact atlas plus one 2x2
terrain color atlas and one 2x2 terrain normal atlas resident, so the active
renderer ledger reserves 16 MiB in either enabled tier. This is a structural
active-set bound, not a relaxation of the logical ceiling. It prevents an
unused 64 MiB ceiling from starving High terrain geometry while all actual
detail allocations remain reported and checked against the tier ceiling.

The proxy-backed KSC NAIP adapter remains disabled unless deployment explicitly
sets `PLANET_DETAIL_MONTHLY_COST_CEILING_USD` to at least **$400**. Direct-CORS
GIBS visual pages, Moon Trek visual/LOLA pages, and USGS 3DEP requests to
`elevation.nationalmap.gov` do not use this proxy gate.

Each terrain generation is limited to nine visual requests plus four numeric
height requests, with a hard combined ceiling of thirteen. Compact rendering
uses only the nine-request visual allowance. The proxy session ceilings below
continue to apply independently to KSC NAIP requests.

The authorization threshold is deliberately conservative. The production route
also fails closed without Redis, caps the rolling 30-day global function budget
at 1,008,000 origin invocations, caps each NAIP response at 512 KiB, and applies
per-IP minute and rolling-month limits. It models 10,000
cold and 10,000 warm active-body sessions at the plan ceilings:

- cold proxy traffic: at most 960,000 invocations and 468.75 GiB;
- warm origin-hit traffic: at most 48,000 invocations and 23.44 GiB (5% of the
  cold-session origin request/egress ceiling);
- total modeled CDN delivery: at most 492.19 GiB;
- total modeled function invocations: at most 1,008,000.

At the highest regional rates in Vercel's January 14, 2026 table, 492.19 GiB of
Fast Data Transfer is about $172.27 and 468.75 GiB of Fast Origin Transfer is
about $201.56 before included allowances. The May 29, 2026 Pro invocation rate
adds about $0.60. The $400 threshold leaves a small margin for request headers,
CPU, and regional rounding; it is an authorization gate, not a promise that the
bill will reach that amount. Actual browser code uses materially smaller 3×3
working sets, persistent caching, and hard per-session request/byte ceilings.

Rate references:

- https://vercel.com/docs/pricing/regional-pricing
- https://vercel.com/changelog/function-invocations-now-billed-per-unit
- https://vercel.com/docs/manage-cdn-usage

The 1,008,000-invocation × 512 KiB server ceilings bound uncached proxy delivery
to 492.19 GiB, matching the modeled CDN maximum even if callers bypass the game
client. CDN cache hits do not need an origin invocation.

Re-run this estimate before enabling the environment variable if Vercel pricing,
deployment region, cache behavior, or the request budgets change.
