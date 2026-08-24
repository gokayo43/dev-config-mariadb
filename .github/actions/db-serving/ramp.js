// The ramp k6 runs when the caller names no script of its own. A repo with a
// hotter path than its health route points `capacity-script` at its own file
// instead; this one exists so that turning the gate on costs one input rather
// than a k6 script nobody has written yet.
//
// dev-config ships the same script for its own database job, and this is a copy
// of it at the pinned SHA rather than a call into it: k6 resolves neither this
// repo's node_modules nor dev-config's, and an action runs from a checkout with
// no node_modules above it at all. CLAUDE.md carries that carve-out;
// tests/ramp-script.ts is what keeps this one honest, by running it under the
// pinned k6 against a stub server and asserting which URLs it reached.
//
// Deliberately no thresholds: on a shared CI runner a latency bound is a coin
// toss, and a gate people disable is worse than a number people read. The one
// bound that is not the runner's — the share of requests the app refused — is
// held by the step that reads the summary, so that it binds a repo ramping with
// a script of its own too. See docs/gates/db-serving.md.
import http from "k6/http";

const health = __ENV.HEALTH_URL;
const origin = health.replace(/^(https?:\/\/[^/]+).*$/, "$1");

// One path per line, the rule every list input in this house follows. Split
// here rather than imported, because this file is the one k6 runs and k6
// resolves neither TypeScript nor Bun. `__ENV` has no entry at all when nobody
// set one, which is what a person running this script by hand does.
const paths = (__ENV.CAPACITY_PATH || "")
  .split("\n")
  .map((path) => path.trim())
  .filter((path) => path !== "");

// Every path the caller named, alongside the health route: an app serves more
// than one route, and a ramp that reaches one of them is what the route floor
// exists to refuse.
const urls = [health].concat(paths.map((path) => origin + path));

export const options = {
  stages: [
    { duration: "20s", target: 20 },
    { duration: "30s", target: 20 },
    { duration: "10s", target: 0 },
  ],
};

export default function () {
  for (const url of urls) {
    http.get(url);
  }
}
