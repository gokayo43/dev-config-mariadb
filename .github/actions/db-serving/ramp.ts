import type { Allowlist } from "../_lib/allowlist.ts";
import { plainly, type Verdict } from "../_lib/annotations.ts";

import { capacity, parseSummary } from "./capacity.ts";
import { asGroup, capturing, killGroup } from "./group.ts";
import { ENDPOINT, type RouteLog } from "./route-log.ts";
import { parseRouteLog, routeCoverage } from "./route-coverage.ts";

/**
 * The ramp: k6 against the app the boot step brought up, with the app's own
 * route counters read either side of it, and the floor those two reads decide.
 *
 * **One verdict, not two.** The measurement and the floor are computed from the
 * same run and published together, because the floor is decidable the moment
 * the second snapshot is on disk — including on the run the failure bound is
 * about to refuse. Split across two steps the floor sat behind `success()`, so
 * a ramp that breached the bound skipped it, and every route nothing reached
 * cost a CI round-trip the measurement had already paid for. That is the
 * failure `publish` in `_lib/annotations.ts` exists to prevent, one level up:
 * annotate everything this run can say, and fail the step once.
 *
 * This is the half that talks to something — the app, and the pinned k6 binary
 * — and `capacity.ts` is the pure reading of what k6 left behind. The same
 * split `db-replay` makes between `database.ts` and `schema.ts`, and for the
 * same reason: the arithmetic that decides a verdict is worth being able to
 * drive without a server under it.
 *
 * Ported from the ramp step of dev-config's `db-gate` at the pinned SHA, which
 * is bash inside its `action.yml`. Deltas, both about what a program can do
 * that a `run:` block cannot:
 *
 *   * k6's own output is **relayed** rather than inherited. A repo pointing
 *     `capacity-script` at a script of its own chooses what that process
 *     writes, and it writes it onto the stdout the runner reads its own
 *     commands off — `annotations.ts`'s `MARGIN` docblock is the argument, and
 *     dev-config#71 is the hole upstream;
 *   * the snapshot is landed by reading the whole answer before writing the
 *     file, rather than by writing a `.part` and renaming it. Upstream needs
 *     the rename because a shell opens the redirect before curl runs and a
 *     failed fetch leaves an empty file that looks like a snapshot somebody
 *     took; nothing here opens the file until there is an answer to put in it.
 */

/**
 * The ramp a caller who names no script of their own gets, which is the file
 * beside this one. Read from here rather than passed in: the action's own
 * directory is the one place that path is true, and a caller that had to say
 * where the shipped script is could say it wrong.
 */
export const SHIPPED = `${import.meta.dir}/ramp.js`;

/** What k6 is asked to report, so that the table below has the percentiles it prints. */
const TREND_STATS = "--summary-trend-stats=avg,min,med,p(95),p(99),max";

/**
 * How long the counter endpoint gets. Bounded for the reason the boot poll is:
 * an app wedged under the ramp accepts the connection and never answers, which
 * is otherwise indistinguishable from a slow read and costs the job's whole
 * timeout to say so. Generous — this is a small JSON body from a local process
 * — so only a hang can reach it.
 */
const SNAPSHOT_MS = 30_000;

/**
 * How long the ramp gets. `capacity-script` is a program of the repo's own —
 * the gate owns the running, the repo owns the meaning — and a script that
 * wedges would otherwise spend the job's whole fifteen minutes, taking the
 * floor, the evidence upload and every diagnostic with it. The shipped ramp is
 * sixty seconds of stages, so this is an order of magnitude over any honest one
 * and still leaves the job time to publish what it has.
 */
export const RAMP_SECONDS = 600;

export interface Ramp {
  /** The pinned k6, fetched and checksum-verified by the step that runs this. */
  readonly k6: string;
  /** The project the caller declared: where k6 runs, and what a repo's own script is relative to. */
  readonly project: string;
  /** How long k6 gets before it is killed, with everything it started. */
  readonly seconds: number;
  /** The script k6 runs: the repo's own `capacity-script`, or the one shipped beside this file. */
  readonly script: string;
  /** The booted app, under the name every step here uses for it. */
  readonly url: string;
  /** `capacity-path`, handed to the script as it was written. */
  readonly paths: string;
  /** The routes the floor is told not to expect, each with the reason it says so. */
  readonly allowlist: Allowlist;
  /** Where the counters as they stood before the ramp are left. */
  readonly before: string;
  /** And after it — the floor is the difference between the two. */
  readonly after: string;
  /** Where k6 exports what it measured. */
  readonly summary: string;
}

/** One read of the app's counters: the counters, or what is wrong with the answer. */
type Snapshot = { readonly counters: RouteLog } | { readonly refused: string };

/**
 * One read of the app's counters, landed on its file and read as what it has to
 * be.
 *
 * The route floor is the difference between these two reads, so the health poll
 * that got the app this far sits inside the first and cannot be mistaken for a
 * route the ramp exercised.
 *
 * The payload is parsed **here**, where the fetch is, rather than after the
 * ramp: a body that is not a route log is a problem this step reports, not an
 * exception thrown past the verdict — one that would take the capacity table,
 * k6's own output and the failure bound's diagnostic with it, and arrive as a
 * bare `JSON Parse error` naming neither the app nor which of the two reads it
 * was. Reading the first one before k6 starts is the other half: an app that
 * cannot answer this is refused before the run rather than after paying for it.
 */
async function snapshot(from: string, onto: string, source: string): Promise<Snapshot> {
  const failed = `${from} did not answer — an app under the capacity ramp serves the route-log endpoint when ROUTE_LOG is set, and without it there is no floor under the ramp at all`;
  let body: string;
  try {
    const answered = await fetch(from, { signal: AbortSignal.timeout(SNAPSHOT_MS) });
    if (!answered.ok) return { refused: `${failed} (it answered ${answered.status})` };
    body = await answered.text();
  } catch {
    return { refused: failed };
  }
  await Bun.write(onto, body);
  try {
    return { counters: parseRouteLog(body, source) };
  } catch (badly) {
    const said = badly instanceof Error ? badly.message : String(badly);
    return {
      refused: `${source} answered ${from} with something that is not a route log — ${said}. An app under ROUTE_LOG serves that endpoint and only that report on it; a catch-all that answers every unmatched path is the usual cause, and it leaves the ramp with no floor under it.`,
    };
  }
}

export async function rampGate({
  k6,
  project,
  seconds,
  script,
  url,
  paths,
  allowlist,
  before,
  after,
  summary,
}: Ramp): Promise<Verdict> {
  // The origin the app is on, which is where its counter endpoint is. The
  // health URL is the one address this job has for the app, and every step
  // takes it from there rather than from a second input that could name
  // another process.
  const routeLog = `${new URL(url).origin}${ENDPOINT}`;

  const first = await snapshot(routeLog, before, "the route log read before the ramp");
  if ("refused" in first) return { problems: [first.refused] };

  // In the project, under a session of its own, and bounded — the three things
  // a program the repo chose needs from the gate running it. The cwd is the
  // project because `capacity-script` is the repo's own path; the session is so
  // that the bound below can take a script that forked; and the bound is
  // `RAMP_SECONDS`, which says why.
  const proc = Bun.spawn(
    asGroup([k6, "run", "--quiet", TREND_STATS, "--summary-export", summary, script]),
    {
      cwd: project,
      env: { ...plainly(process.env), HEALTH_URL: url, CAPACITY_PATH: paths },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const said = capturing(proc.stdout);
  const wrote = capturing(proc.stderr);
  const RAN_LONG = Symbol("the ramp's bound fired");
  let bound: ReturnType<typeof setTimeout> | undefined;
  const finished = await Promise.race([
    Promise.all([said.text, wrote.text, proc.exited]),
    new Promise<typeof RAN_LONG>((resolve) => {
      bound = setTimeout(() => resolve(RAN_LONG), seconds * 1000);
    }),
  ]);
  clearTimeout(bound);

  if (finished === RAN_LONG) {
    killGroup(proc.pid);
    // The reads are put down for the reason `group.ts` gives at `capturing`: a
    // survivor holding the write end of these pipes would otherwise keep this
    // process alive after the verdict is written.
    said.abandon();
    wrote.abandon();
    const [out, err] = await Promise.all([said.text, wrote.text]);
    return {
      log: `${out}${err}`.trimEnd(),
      problems: [
        `the ramp was still running after ${seconds}s and was killed, along with everything it had started — ${script} either wedged or is measuring something far longer than a ramp, and the job's own budget is what it would otherwise spend`,
      ],
    };
  }

  const [out, err, status] = finished;
  const log = `${out}${err}`.trimEnd();

  if (status !== 0) {
    return {
      log,
      problems: [
        `k6 exited ${status} against ${script} — its own output is above. Nothing after this ran, so the route floor has not been measured either.`,
      ],
    };
  }

  // An app that died under the ramp fails this snapshot AND breaches the
  // failure bound, and the bound is the diagnostic that says what happened — so
  // this failure is held until the measurement has been read and published, and
  // the step then fails carrying both.
  const second = await snapshot(routeLog, after, "the route log read after the ramp");

  // Refused by name rather than met as an ENOENT three frames later. k6 exiting
  // 0 having exported nothing is reachable through a `capacity-script` of the
  // repo's own — the same untrusted input whose SHAPE the parse already refuses
  // — and "the file is not there" is the reading of it that no arithmetic can
  // survive.
  const exported = Bun.file(summary);
  if (!(await exported.exists())) {
    return {
      log,
      problems: [
        `k6 exited 0 against ${script} and exported no summary to ${summary} — its own output is above. The measurement IS the summary, so there is nothing here to publish and nothing to hold to the failure bound.`,
      ],
    };
  }

  const measured = capacity(parseSummary(await exported.text()));
  if ("refused" in second) {
    return { ...measured, log, problems: [...measured.problems, second.refused] };
  }

  // The floor, from the two reads this step took: a route whose count rose is a
  // route the ramp reached. It is decided here rather than in a step of its own
  // for the reason the docblock gives — a measurement the bound refuses is
  // still a run whose routes are worth naming.
  const floor = routeCoverage(first.counters, second.counters, allowlist);
  const noted = floor.note === undefined ? {} : { note: floor.note };
  return {
    ...measured,
    ...noted,
    log,
    problems: [...measured.problems, ...floor.problems],
  };
}
