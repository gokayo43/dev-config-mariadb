import { expect, test } from "bun:test";
import { join } from "node:path";

import { allowlistFrom } from "../.github/actions/_lib/allowlist.ts";
import { RAMP_SECONDS, rampGate, SHIPPED } from "../.github/actions/db-serving/ramp.ts";

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

async function ramp(
  plan: Plan,
  mode: Mode = "serving",
  paths = "/api/things",
  allowlist = "",
): Promise<Ramped> {
  const root = await materialise({});
  const app = await serving(root, mode);
  const script = join(root, "plan.json");
  await Bun.write(script, JSON.stringify({ ...plan, stopApp: plan.stopApp }));
  const where = {
    before: join(root, "route-log-before.json"),
    after: join(root, "route-log-after.json"),
    summary: join(root, "capacity.json"),
  };
  const verdict = await rampGate({
    k6: K6,
    project: root,
    seconds: RAMP_SECONDS,
    script,
    url: app.url,
    paths,
    allowlist: allowlistFrom(allowlist, "route-allowlist"),
    ...where,
  });
  return { verdict, url: app.url, ...where };
}

test("the ramp measures the app, and the floor is the difference between two reads of its counters", async () => {
  const ran = await ramp({ summary: CAPTURED });

  expect(ran.verdict.table).toContain("| Requests | 137994 |");

  // The app answered the health poll before the first snapshot was taken — that
  // is what `serving` does — so GET /health carries a count on both sides and
  // is covered only because the ramp moved it.
  const before: unknown = await Bun.file(ran.before).json();
  expect(JSON.stringify(before)).toContain("/health");

  // Ramped: the health route and the one capacity-path. Not ramped: the two
  // routes nothing was aimed at.
  expect(ran.verdict.problems).toHaveLength(2);
  expect(ran.verdict.problems.join("\n")).toContain(
    "POST /api/things is served but no ramp request",
  );
  expect(ran.verdict.problems.join("\n")).toContain(
    "ALL /api/events is served but no ramp request",
  );
  expect(ran.verdict.note).toContain("2 of 4 routes exercised by the ramp");
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

  expect(ran.verdict.problems).toEqual([]);
  expect(ran.verdict.note).toContain("4 of 4 routes exercised by the ramp");
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
    project: root,
    seconds: RAMP_SECONDS,
    script,
    url: app.url,
    paths: "",
    allowlist: allowlistFrom("", "route-allowlist"),
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

test("a ramp the failure bound refuses still carries what the floor found", async () => {
  // The two verdicts are one step because the floor is computable whenever the
  // second snapshot was taken, and an app that answered badly under load is
  // exactly when a reader also wants to know which routes nothing reached. Two
  // steps put the floor behind `success()`, so every route problem cost a CI
  // round-trip that the measurement had already earned.
  const ran = await ramp({ summary: REFUSED });

  expect(ran.verdict.table).toContain("| Failed requests | 50.00% |");
  const said = ran.verdict.problems.join("\n");
  expect(said).toContain("of the ramp's requests failed");
  expect(said).toContain("POST /api/things is served but no ramp request exercises it");
  expect(said).toContain("ALL /api/events is served but no ramp request exercises it");
  expect(ran.verdict.note).toContain("2 of 4 routes exercised by the ramp");
}, 30_000);

test("a k6 that exits 0 having exported nothing is refused by name, not by an ENOENT", async () => {
  // Reachable through a `capacity-script` of the repo's own, which is the same
  // untrusted input whose shape the summary parse already refuses.
  const ran = await ramp({});

  expect(ran.verdict.problems).toHaveLength(1);
  expect(ran.verdict.problems[0]).toContain("exported no summary");
  expect(ran.verdict.problems[0]).toContain("The measurement IS the summary");
});

test("the allowlist the caller wrote reaches the floor the ramp decides", async () => {
  const ran = await ramp(
    { summary: CAPTURED },
    "serving",
    "/api/things",
    "POST /api/things -- written by the importer, and no ramp of ours may write rows\nALL /api/events -- the sse stream never completes a request under a ramp",
  );

  expect(ran.verdict.problems).toEqual([]);
  expect(ran.verdict.note).toContain("2 allowlisted");
}, 30_000);

test("a route log that is not one is a problem this step reports, not an exception past it", async () => {
  // An app whose unmatched-path handler answers 200 — an SPA catch-all — serves
  // a page on the instrument's path. Parsed after the measurement, that threw
  // past `publish`: no table, no k6 output, and the failure bound's own
  // diagnostic lost, under a bare `JSON Parse error` naming neither the app nor
  // which of the two reads it was.
  const ran = await ramp({ summary: REFUSED }, "html-catch-all");

  expect(ran.verdict.problems).toHaveLength(1);
  expect(ran.verdict.problems[0]).toContain("the route log read before the ramp answered");
  expect(ran.verdict.problems[0]).toContain("is not a route log");
  expect(ran.verdict.problems[0]).toContain("a catch-all that answers every unmatched path");
  // Before the run rather than after paying for it: the first read is what this
  // refuses, so k6 was never spawned.
  expect(await Bun.file(ran.summary).exists()).toBe(false);
}, 30_000);

test("a ramp that wedges is killed at its bound rather than spending the job", async () => {
  const root = await materialise({});
  const app = await serving(root, "serving");
  const script = join(root, "plan.json");
  await Bun.write(script, JSON.stringify({ summary: CAPTURED, wedge: true }));

  const started = Date.now();
  const verdict = await rampGate({
    k6: K6,
    project: root,
    // The shipped bound is ten minutes and the argument for it is in ramp.ts;
    // what this case is about is that there is one at all.
    seconds: 2,
    script,
    url: app.url,
    paths: "",
    allowlist: allowlistFrom("", "route-allowlist"),
    before: join(root, "before.json"),
    after: join(root, "after.json"),
    summary: join(root, "capacity.json"),
  });

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain("still running after 2s and was killed");
  expect(Date.now() - started).toBeLessThan(20_000);
}, 30_000);
