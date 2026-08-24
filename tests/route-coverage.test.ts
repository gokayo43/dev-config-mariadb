import { expect, test } from "bun:test";

import { allowlistFrom } from "../.github/actions/_lib/allowlist.ts";
import { parseRouteLog, routeCoverage } from "../.github/actions/db-serving/route-coverage.ts";
import type { Route, RouteLog, Served } from "../.github/actions/db-serving/route-log.ts";

/**
 * The floor, graded directly: what is covered is the **difference** between two
 * reads of the app's counters, and every case here is about a way of getting
 * that wrong that still looks right on a green run.
 *
 * The payloads are written out rather than captured, and that is the one place
 * in this suite where that is the right answer: this is the protocol's own
 * shape, declared in `route-log.ts` and held to dev-config's declaration by
 * `route-log.test.ts`. `ramp.test.ts` is where a real app's real payload goes
 * through the same reader.
 */

const THINGS = { method: "GET", path: "/api/things" };
const EVENTS = { method: "ALL", path: "/api/events" };
const HEALTH = { method: "GET", path: "/health" };

function log(routeTable: Route[], counts: Served[]): RouteLog {
  return { routeTable, counts };
}

/** No allowlist at all, which is what nearly every consumer writes. */
const NONE = allowlistFrom("", "route-allowlist");

test("a route the ramp reached is covered and a route it did not is refused", () => {
  const before = log(
    [HEALTH, THINGS],
    [
      { ...HEALTH, count: 4 },
      { ...THINGS, count: 11 },
    ],
  );
  // The health route rose; the things route stood still at eleven. Reading a
  // non-zero count as coverage is the plausible wrong implementation, and the
  // eleven requests here are what a boot poll or an earlier deploy's traffic
  // looks like to it.
  const after = log(
    [HEALTH, THINGS],
    [
      { ...HEALTH, count: 900 },
      { ...THINGS, count: 11 },
    ],
  );

  const verdict = routeCoverage(before, after, NONE);

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain(
    "GET /api/things is served but no ramp request exercises it",
  );
  expect(verdict.note).toBe("route coverage: 1 of 2 routes exercised by the ramp, 0 allowlisted");
});

test("a route with no counts at all is refused rather than read as zero traffic", () => {
  const verdict = routeCoverage(log([THINGS], []), log([THINGS], []), NONE);

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain(
    "GET /api/things is served but no ramp request exercises it",
  );
});

test("a route registered for every method is covered by whichever method reached it", () => {
  const before = log([EVENTS], []);
  const after = log([EVENTS], [{ method: "POST", path: "/api/events", count: 3 }]);

  expect(routeCoverage(before, after, NONE).problems).toEqual([]);
});

test("a catch-all is not credited with what its concrete neighbour served", () => {
  // `GET /api/events` beside `ALL /api/events`: the router hands a GET to the
  // first, so GET traffic is exactly what the catch-all did NOT serve. A gate
  // crediting it anyway marks a handler covered that the ramp never ran.
  const table = [EVENTS, { method: "GET", path: "/api/events" }];
  const before = log(table, []);
  const after = log(table, [{ method: "GET", path: "/api/events", count: 7 }]);

  const verdict = routeCoverage(before, after, NONE);

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain(
    "ALL /api/events is served but no ramp request exercises it",
  );
});

test("an allowlisted route is waived, and the waiver is counted where a reader can see it", () => {
  const before = log([THINGS], []);
  const after = log([THINGS], []);
  const allowlist = allowlistFrom(
    "GET /api/things -- the cors plugin answers before the request reaches a route",
    "route-allowlist",
  );

  const verdict = routeCoverage(before, after, allowlist);

  expect(verdict.problems).toEqual([]);
  expect(verdict.note).toContain("1 allowlisted");
});

test("an entry that waives a route the ramp did exercise is refused", () => {
  // An escape hatch nobody can see rotting is how a gate quietly stops covering
  // what it names.
  const before = log([THINGS], [{ ...THINGS, count: 1 }]);
  const after = log([THINGS], [{ ...THINGS, count: 40 }]);
  const allowlist = allowlistFrom(
    "GET /api/things -- no load generator reaches this",
    "route-allowlist",
  );

  const verdict = routeCoverage(before, after, allowlist);

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain("which the ramp did exercise");
});

test("an entry naming a route the app does not serve is refused", () => {
  const verdict = routeCoverage(
    log([THINGS], []),
    log([THINGS], []),
    allowlistFrom(
      "GET /api/thigns -- typo, and nothing catches a typo in a waiver",
      "route-allowlist",
    ),
  );

  // The route it was written for is still uncovered, and the entry is still
  // rotten: two mistakes, two diagnostics.
  expect(verdict.problems).toHaveLength(2);
  expect(verdict.problems.join("\n")).toContain("which this app does not serve");
});

test("an entry that is not a route at all is refused as one", () => {
  const verdict = routeCoverage(
    log([THINGS], [{ ...THINGS, count: 2 }]),
    log([THINGS], [{ ...THINGS, count: 9 }]),
    allowlistFrom("/api/things -- no method on it", "route-allowlist"),
  );

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain("is not a route — write 'METHOD /path'");
});

test("an entry with no reason earns exactly one diagnostic, and still waives its route", () => {
  const verdict = routeCoverage(
    log([THINGS], []),
    log([THINGS], []),
    allowlistFrom("GET /api/things", "route-allowlist"),
  );

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain("waives GET /api/things without saying why");
});

test("an app that names no routes is refused: a floor that cannot see them is not a floor", () => {
  const verdict = routeCoverage(log([], []), log([], []), NONE);

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain("reported an empty routeTable");
  // A refusal with nothing under it cannot be built here either: the note says
  // what was measured on the run that failed.
  expect(verdict.note).toBe("route coverage: no route table");
});

test("a payload that is not a route log says so rather than covering less than it claims", () => {
  expect(() => parseRouteLog("[]", "the route log")).toThrow("the top level is a list");
  expect(() => parseRouteLog('{"counts":[]}', "the route log")).toThrow("routeTable is absent");
  expect(() => parseRouteLog('{"routeTable":[],"counts":{}}', "the route log")).toThrow(
    "counts is an object",
  );
  expect(() =>
    parseRouteLog('{"routeTable":[{"method":"GET"}],"counts":[]}', "the route log"),
  ).toThrow('which is not a {"method","path"} pair');
  expect(() =>
    parseRouteLog('{"routeTable":[],"counts":[{"method":"GET","path":"/x"}]}', "the route log"),
  ).toThrow('which is not a {"method","path","count"} row');
});
