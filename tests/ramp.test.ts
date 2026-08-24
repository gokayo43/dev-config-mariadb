import { expect, test } from "bun:test";
import { join } from "node:path";

import { allowlistFrom } from "../.github/actions/_lib/allowlist.ts";
import { parseRouteLog, routeCoverage } from "../.github/actions/db-serving/route-coverage.ts";
import { rampGate, SHIPPED } from "../.github/actions/db-serving/ramp.ts";

import { type Mode, serving } from "./app.ts";
import { materialise } from "./tree.ts";

/**
 * The ramp step against a real app: its counters really are read either side of
 * the run, the payloads really are the ones `served-app.ts` builds from
 * dev-config's own protocol module, and the floor really is graded on the
 * difference between two of them.
 *
 * k6 itself is a fake — `fake-k6.ts` says why, and what it still asserts about
 * how it was invoked. The pinned binary runs the shipped ramp in
 * `ramp-script.ts`, which is a CI step for the reason a binary cannot be
 * fetched from inside `bun test`.
 */

const K6 = join(import.meta.dir, "fake-k6.ts");
const CAPTURED = join(import.meta.dir, "k6-summary.json");
const REFUSED = join(import.meta.dir, "k6-summary-refused.json");

interface Plan {
  readonly summary?: string;
  readonly also?: { readonly method: string; readonly path: string }[];
  readonly stopApp?: string;
  readonly exit?: number;
}

interface Ramped {
  readonly verdict: Awaited<ReturnType<typeof rampGate>>;
  readonly before: string;
  readonly after: string;
  readonly summary: string;
  readonly url: string;
}

async function ramp(plan: Plan, mode: Mode = "serving", paths = "/api/things"): Promise<Ramped> {
  const root = await materialise({});
  const app = await serving(root, mode);
  const script = join(root, "plan.json");
  await Bun.write(script, JSON.stringify({ ...plan, stopApp: plan.stopApp }));
  const where = {
    before: join(root, "route-log-before.json"),
    after: join(root, "route-log-after.json"),
    summary: join(root, "capacity.json"),
  };
  const verdict = await rampGate({ k6: K6, script, url: app.url, paths, ...where });
  return { verdict, url: app.url, ...where };
}

/** The floor's own verdict over what the ramp left behind, which is what the step after it does. */
async function coverage(ran: Ramped, allowlist = ""): Promise<ReturnType<typeof routeCoverage>> {
  return routeCoverage(
    parseRouteLog(await Bun.file(ran.before).text(), "before"),
    parseRouteLog(await Bun.file(ran.after).text(), "after"),
    allowlistFrom(allowlist, "route-allowlist"),
  );
}

test("the ramp measures the app, and the floor is the difference between two reads of its counters", async () => {
  const ran = await ramp({ summary: CAPTURED });

  expect(ran.verdict.problems).toEqual([]);
  expect(ran.verdict.table).toContain("| Requests | 137994 |");

  // The app answered the health poll before the first snapshot was taken — that
  // is what `serving` does — so GET /health carries a count on both sides and
  // is covered only because the ramp moved it.
  const before: unknown = await Bun.file(ran.before).json();
  expect(JSON.stringify(before)).toContain("/health");

  const floor = await coverage(ran);
  // Ramped: the health route and the one capacity-path. Not ramped: the two
  // routes nothing was aimed at.
  expect(floor.problems).toHaveLength(2);
  expect(floor.problems.join("\n")).toContain("POST /api/things is served but no ramp request");
  expect(floor.problems.join("\n")).toContain("ALL /api/events is served but no ramp request");
  expect(floor.note).toContain("2 of 4 routes exercised by the ramp");
}, 30_000);

test("a ramp that reaches every route leaves the floor with nothing to refuse", async () => {
  const ran = await ramp({
    summary: CAPTURED,
    // The two the shipped ramp's paths do not reach: a method of its own on a
    // route that has one, and a method nothing else claims on the catch-all.
    also: [
      { method: "POST", path: "/api/things" },
      { method: "DELETE", path: "/api/events" },
    ],
  });

  const floor = await coverage(ran);
  expect(floor.problems).toEqual([]);
  expect(floor.note).toContain("4 of 4 routes exercised by the ramp");
}, 30_000);

test("an app with no route-log endpoint fails before k6 is run at all", async () => {
  const ran = await ramp({ summary: CAPTURED }, "no-instrument");

  expect(ran.verdict.problems).toHaveLength(1);
  expect(ran.verdict.problems[0]).toContain("did not answer");
  expect(ran.verdict.problems[0]).toContain("serves the route-log endpoint when ROUTE_LOG is set");
  // Nothing was measured, because nothing was run: a floor that cannot see the
  // routes is not a floor, and a number under it would be a number nobody can
  // hold to anything.
  expect(await Bun.file(ran.summary).exists()).toBe(false);
}, 30_000);

test("a k6 that died is reported by its own output, and the floor is not measured", async () => {
  const ran = await ramp({ summary: CAPTURED, exit: 4 });

  expect(ran.verdict.problems).toHaveLength(1);
  expect(ran.verdict.problems[0]).toContain("k6 exited 4");
  expect(ran.verdict.problems[0]).toContain("the route floor has not been measured either");
  expect(await Bun.file(ran.after).exists()).toBe(false);
}, 30_000);

test("an app that dies under the ramp fails carrying both what it measured and what it could not read", async () => {
  const root = await materialise({});
  const app = await serving(root, "serving");
  const script = join(root, "plan.json");
  // The app is killed after the summary is written, which is what a process
  // that dies under load leaves behind: a measurement of a run that went wrong,
  // and a counter endpoint that no longer answers.
  await Bun.write(script, JSON.stringify({ summary: REFUSED, stopApp: app.pidFile }));

  const verdict = await rampGate({
    k6: K6,
    script,
    url: app.url,
    paths: "",
    before: join(root, "before.json"),
    after: join(root, "after.json"),
    summary: join(root, "capacity.json"),
  });

  // The bound the app breached is the diagnostic that says what happened, so
  // the snapshot's failure is held until the measurement has been published.
  expect(verdict.table).toContain("| Failed requests | 50.00% |");
  expect(verdict.problems).toHaveLength(2);
  expect(verdict.problems[0]).toContain("of the ramp's requests failed");
  expect(verdict.problems[1]).toContain("did not answer");
}, 30_000);

test("the ramp a caller who names no script gets is the one shipped beside the action", async () => {
  expect(await Bun.file(SHIPPED).exists()).toBe(true);
});
