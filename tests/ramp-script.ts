// Runs the shipped k6 ramp against a stub server, every way round: with a hot
// path, with a list of them, with none, and with one that does not exist. "It
// runs inside k6" is why the linter and knip skip this script; it is not a
// reason for nothing to have executed it.
//
// A CI step rather than a bun test, because it needs the pinned k6 binary —
// ci.yml fetches it through the same k6.sh the ramp step sources, and a
// developer runs this with K6 pointing at one.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isForeign } from "../.github/actions/_lib/foreign.ts";
import { parseSummary, type Summary } from "../.github/actions/db-serving/capacity.ts";
import { SHIPPED } from "../.github/actions/db-serving/ramp.ts";

function fromEnvironment(name: string): string {
  const value = Bun.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is unset — point it at the pinned k6 binary (CI sources k6.sh before this runs)`,
    );
  }
  return value;
}

const k6 = fromEnvironment("K6");

const hits = new Map<string, number>();
const ANSWERS = new Set(["/api/health", "/api/things", "/api/presets"]);

// Everything else 404s, which is what a mistyped capacity-path meets — and what
// the failure bound in capacity.ts refuses once the summary reaches it. Port 0,
// and a directory of this run's own below: the box this runs on may be running
// a second checkout of this repo at the same time.
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const { pathname } = new URL(request.url);
    hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
    return ANSWERS.has(pathname)
      ? Response.json({ status: "ok" })
      : new Response("no such route", { status: 404 });
  },
});

// One short stage, because this proves the script's branches rather than the
// machine's throughput — the ramp's shape is the action's business.
const STAGE = "--stage=2s:5";

const summaries = await mkdtemp(join(tmpdir(), "ramp-script-"));

async function ramp(
  capacityPath: string | undefined,
  name: string,
): Promise<{ readonly exitCode: number; readonly summary: Summary }> {
  hits.clear();
  const exported = join(summaries, `${name}.json`);
  const proc = Bun.spawn([k6, "run", "--quiet", STAGE, "--summary-export", exported, SHIPPED], {
    env: {
      PATH: fromEnvironment("PATH"),
      HEALTH_URL: `http://127.0.0.1:${server.port}/api/health`,
      ...(capacityPath === undefined ? {} : { CAPACITY_PATH: capacityPath }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  return { exitCode, summary: parseSummary(await Bun.file(exported).text()) };
}

function holds(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

function statistic(summary: Summary, metric: string, name: string): number {
  const value = summary.metrics[metric]?.[name];
  holds(value !== undefined, `the summary carries no ${metric}.${name}`);
  return value ?? 0;
}

const health = await ramp("", "health");
holds((hits.get("/api/health") ?? 0) > 0, "the health route was never ramped");
holds(hits.size === 1, `only the health route should be hit, saw ${[...hits.keys()].join(", ")}`);
holds(health.exitCode === 0, "a ramp against a server that answers 200 did not exit 0");
holds(
  statistic(health.summary, "http_req_failed", "value") === 0,
  "a request failed against a server that answers everything",
);

// The variable is absent when a person runs this by hand, and that branch is
// how a URL ending in the literal "undefined" gets built.
const absent = await ramp(undefined, "absent");
holds(
  hits.size === 1,
  `an absent CAPACITY_PATH must ramp the health route alone, saw ${[...hits.keys()].join(", ")}`,
);
holds(absent.exitCode === 0, "an absent CAPACITY_PATH did not exit 0");

const many = await ramp("/api/things\n/api/presets\n", "many");
holds(many.exitCode === 0, `a ramp over a list of paths exited ${many.exitCode}`);
holds(
  (hits.get("/api/things") ?? 0) > 0 && (hits.get("/api/presets") ?? 0) > 0,
  `a list must ramp every path in it, saw ${[...hits.keys()].join(", ")}`,
);
holds(
  (hits.get("/api/health") ?? 0) > 0,
  "the health route was dropped when a list of paths was given",
);

// A capacity-path with a typo in it: k6 keeps ramping, the run is a clean exit,
// and the throughput is the throughput of a 404. The bound that refuses that
// lives in the step which reads the summary, so what this proves is the seam it
// reads across — the field the failures land in, and that they land there
// rather than in the exit code.
const typo = await ramp("/api/thigns", "typo");
holds(
  typo.exitCode === 0,
  `a ramp against a 404 exited ${typo.exitCode} — the shipped script declares no threshold, so the summary is what carries the failures`,
);
holds(
  statistic(typo.summary, "http_req_failed", "value") > 0.1,
  "half the ramp's requests 404d and http_req_failed.value did not record it — the gate reads that field",
);

await server.stop(true);
await rm(summaries, { recursive: true, force: true });
holds(isForeign(typo.summary.metrics), "the summary is not the shape the gate reads");
// oxlint-disable-next-line eslint/no-console -- this script is a CI step, not a module: stdout is the only channel it has to report what it executed
console.log("ramp.js: the health-only, absent, list and typo branches all executed");
