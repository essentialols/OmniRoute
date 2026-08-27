/**
 * Kubernetes-style readiness alias of /healthz.
 * Same lifecycle phase, same 200/503 bodies. Not a liveness probe.
 */
// `dynamic` is declared here rather than re-exported from ../healthz/route:
// Next.js parses route segment config statically at compile time and rejects a
// re-exported binding ("can't recognize the exported `dynamic` field in route").
// Must stay in lockstep with healthz's own value.
export const dynamic = "force-dynamic";

export { GET, HEAD } from "../healthz/route";
