import { expect, test } from "bun:test";
import { join } from "node:path";

import { capacity, parseSummary, type Summary } from "../.github/actions/db-serving/capacity.ts";

/**
 * What the ramp publishes and what it fails on, read from **real k6 exports**.
 * Both fixtures beside this file were written by the pinned k6 running the
 * shipped ramp against `served-app.ts`: one against routes that answer, one
 * against a path with a typo in it, which is what a mistyped `capacity-path`
 * really produces. A hand-typed summary would be this suite agreeing with
 * itself about a file format neither end owns.
 */

async function summaryFrom(name: string): Promise<Summary> {
  return parseSummary(await Bun.file(join(import.meta.dir, name)).text());
}

const RAMPED = await summaryFrom("k6-summary.json");
const REFUSED = await summaryFrom("k6-summary-refused.json");

test("the measurement is published as the table a reader reads", () => {
  const { table, problems } = capacity(RAMPED);

  expect(problems).toEqual([]);
  expect(table).toContain("| Requests | 137994 |");
  expect(table).toContain("| Peak VUs | 5 |");
  expect(table).toContain("| Failed requests | 0.00% |");
  expect(table).toContain("| Mean requests/s (whole run incl. ramp) | 45994.8 |");
  expect(table).toContain("| Latency p(95) | 0.1 ms |");
  // The caption is the difference between a trend datum and a capacity claim,
  // and this ramp is the first of the two.
  expect(table).toContain("not the deployed shape");
});

test("a ramp whose requests the app refused fails, and still publishes what it measured", () => {
  const { table, problems } = capacity(REFUSED);

  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain(
    "50.00% of the ramp's requests failed, over the 10% this gate allows",
  );
  // A summary that appeared only on green runs would be missing from every run
  // that needed one: the failure rate is what says which way the ramp went.
  expect(table).toContain("| Failed requests | 50.00% |");
});

test("the bound is a tenth, and a tenth exactly is inside it", () => {
  // The plausible wrong implementation is `>=`, and the two cases that separate
  // them are one number apart. Written out rather than captured: this is
  // arithmetic over this repo's own type, and no k6 run lands on a tenth to
  // order.
  const at = (failed: number): Summary => ({
    metrics: {
      http_reqs: { count: 100, rate: 10 },
      vus_max: { max: 5 },
      http_req_failed: { value: failed },
      http_req_duration: { "p(95)": 1, "p(99)": 2, max: 3 },
    },
  });

  expect(capacity(at(0.1)).problems).toEqual([]);
  expect(capacity(at(0.100_001)).problems).toHaveLength(1);
});

test("a ramp that made no requests is a run with no number to record", () => {
  const none: Summary = { metrics: { http_reqs: { count: 0, rate: 0 } } };
  const { table, problems } = capacity(none);

  expect(table).toBeUndefined();
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("k6 ran but measured nothing");
});

test("a summary k6 did not write says so rather than turning into arithmetic", () => {
  expect(() => parseSummary("[]")).toThrow("the top level is a list");
  expect(() => parseSummary('{"metrics":42}')).toThrow("metrics is a number");
  // A shape that parses but has stopped carrying what the table reads: the
  // failure names the stat rather than surfacing as a blank row.
  expect(() => capacity({ metrics: { http_reqs: { count: 1, rate: 1 } } })).toThrow(
    "the k6 summary has no vus_max.max",
  );
});
