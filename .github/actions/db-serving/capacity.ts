import type { Verdict } from "../_lib/annotations.ts";
import { isForeign, kindOf } from "../_lib/foreign.ts";

/**
 * What k6 left behind, read and turned into the measurement this job publishes.
 * Pure: `ramp.ts` is what runs k6 and talks to the app, and this is the half
 * that decides what the run said — the same split `db-replay` makes between
 * `database.ts` and `schema.ts`.
 *
 * Ported from dev-config's `db-gate/capacity.ts` at the pinned SHA, minus their
 * `ran-on`. That input names the machine the ramp found, because their reader
 * has two callers — the database job on a runner, and project-template's
 * `preview-capacity.sh` against a preview stack on the box that would serve it.
 * This one has the first caller and no second, so the caption below is written
 * out rather than selected. A ramp against the deployed shape is what
 * testing.md asks for before a surface takes real users, and it is not this: it
 * is that script, in the repo that ships the surface.
 */

/** A metric as k6 exports it: a name per statistic, and nothing claimed about which. */
type Statistics = Record<string, number>;

export interface Summary {
  readonly metrics: Record<string, Statistics>;
}

/**
 * Parsed at the boundary rather than asserted through. k6's summary is a file
 * this action did not write — a repo may point `capacity-script` at its own
 * script — so a shape that is not the one read here says so loudly instead of
 * surfacing later as an arithmetic result nobody can explain.
 */
export function parseSummary(text: string): Summary {
  const parsed: unknown = JSON.parse(text);
  if (!isForeign(parsed)) {
    throw new Error(`the summary is not the k6 export shape: the top level is ${kindOf(parsed)}`);
  }
  // An absent metrics is a summary holding nothing, which the table reports as
  // the run that measured nothing. One that is there and is not an object
  // belongs to a file k6 did not write, and no arithmetic over it means
  // anything — least of all the zero it would otherwise read as.
  const found = parsed["metrics"];
  if (found !== undefined && !isForeign(found)) {
    throw new Error(`the summary is not the k6 export shape: metrics is ${kindOf(found)}`);
  }
  return {
    metrics: Object.fromEntries(
      Object.entries(isForeign(found) ? found : {}).map(([name, stats]) => [
        name,
        // Anything under a metric that is not a number is left out rather than
        // read as one: what the table asks for is named, and a stat that has
        // stopped being a number is a missing stat with a diagnostic of its own.
        Object.fromEntries(
          Object.entries(isForeign(stats) ? stats : {}).filter(
            (entry): entry is [string, number] => typeof entry[1] === "number",
          ),
        ),
      ]),
    ),
  };
}

function stat(summary: Summary, metric: string, name: string): number {
  const value = summary.metrics[metric]?.[name];
  if (value === undefined) throw new Error(`the k6 summary has no ${metric}.${name}`);
  return value;
}

function ms(value: number): string {
  return `${value.toFixed(1)} ms`;
}

/**
 * The measurement, for the run summary — or nothing, when the ramp made no
 * requests and there is no number to record.
 */
function capacityTable(summary: Summary): string | undefined {
  const requests = summary.metrics["http_reqs"];
  if (requests === undefined || (requests["count"] ?? 0) === 0) return undefined;

  return [
    "### Capacity",
    "",
    "| Measurement | Value |",
    "| --- | --- |",
    // The whole run over its whole duration, ramp-up and ramp-down included,
    // which is the only rate k6's summary carries: below the plateau, and a
    // trend datum rather than a throughput this app reached.
    `| Mean requests/s (whole run incl. ramp) | ${stat(summary, "http_reqs", "rate").toFixed(1)} |`,
    `| Requests | ${stat(summary, "http_reqs", "count")} |`,
    `| Peak VUs | ${stat(summary, "vus_max", "max")} |`,
    `| Failed requests | ${(stat(summary, "http_req_failed", "value") * 100).toFixed(2)}% |`,
    `| Latency p(95) | ${ms(stat(summary, "http_req_duration", "p(95)"))} |`,
    `| Latency p(99) | ${ms(stat(summary, "http_req_duration", "p(99)"))} |`,
    `| Latency max | ${ms(stat(summary, "http_req_duration", "max"))} |`,
    "",
    "Measured on a CI runner, which is not the deployed shape: read it against",
    "the last run rather than as a capacity claim. The number that answers",
    '"how much load does this hold" comes from a ramp against the deploy.',
    "",
  ].join("\n");
}

/**
 * A tenth of the ramp's requests. Latency and throughput belong to whatever
 * machine the ramp found, and a gate that fails on those gets disabled within a
 * month — but a request the app refused is refused on any machine, so this one
 * bound says something about the app wherever it ran.
 */
const FAILURE_BOUND = 0.1;

/**
 * What the step publishes and what it fails on, from the one file k6 leaves
 * behind. The bound lives here rather than in the shipped script's thresholds
 * because `capacity-script` replaces that file entirely: a repo ramping with a
 * script of its own would otherwise publish the throughput of its own error
 * page, and the rule that decides what counts as a measurement would have two
 * homes that could disagree.
 *
 * The table is the whole of what this one has to say: the number is in it, and
 * a note repeating a row of it would be a second reading of the same run.
 */
export function capacity(summary: Summary): Verdict {
  const table = capacityTable(summary);
  if (table === undefined) {
    return {
      problems: [
        "the capacity ramp produced no requests — k6 ran but measured nothing, so there is no number to record",
      ],
    };
  }

  const failed = stat(summary, "http_req_failed", "value");
  return {
    table,
    problems:
      failed > FAILURE_BOUND
        ? [
            `${(failed * 100).toFixed(2)}% of the ramp's requests failed, over the ${(FAILURE_BOUND * 100).toFixed(0)}% this gate allows — the published number is the throughput of whatever answered, so fix the app or the path the scenario ramps`,
          ]
        : [],
  };
}
