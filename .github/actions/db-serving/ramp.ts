import { plainly, type Verdict } from "../_lib/annotations.ts";

import { capacity, parseSummary } from "./capacity.ts";
import { ENDPOINT } from "./route-log.ts";

/**
 * The ramp: k6 against the app the boot step brought up, with the app's own
 * route counters read either side of it.
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

export interface Ramp {
  /** The pinned k6, fetched and checksum-verified by the step that runs this. */
  readonly k6: string;
  /** The script k6 runs: the repo's own `capacity-script`, or the one shipped beside this file. */
  readonly script: string;
  /** The booted app, under the name every step here uses for it. */
  readonly url: string;
  /** `capacity-path`, handed to the script as it was written. */
  readonly paths: string;
  /** Where the counters as they stood before the ramp are left. */
  readonly before: string;
  /** And after it — the floor is the difference between the two. */
  readonly after: string;
  /** Where k6 exports what it measured. */
  readonly summary: string;
}

/**
 * One read of the app's counters, landed on its file or not taken at all.
 *
 * The route floor is the difference between these two reads, so the health poll
 * that got the app this far sits inside the first and cannot be mistaken for a
 * route the ramp exercised.
 */
async function snapshot(from: string, onto: string): Promise<string | undefined> {
  const failed = `${from} did not answer — an app under the capacity ramp serves the route-log endpoint when ROUTE_LOG is set, and without it there is no floor under the ramp at all`;
  try {
    const answered = await fetch(from, { signal: AbortSignal.timeout(SNAPSHOT_MS) });
    if (!answered.ok) return `${failed} (it answered ${answered.status})`;
    await Bun.write(onto, await answered.text());
    return undefined;
  } catch {
    return failed;
  }
}

export async function rampGate({
  k6,
  script,
  url,
  paths,
  before,
  after,
  summary,
}: Ramp): Promise<Verdict> {
  // The origin the app is on, which is where its counter endpoint is. The
  // health URL is the one address this job has for the app, and every step
  // takes it from there rather than from a second input that could name
  // another process.
  const routeLog = `${new URL(url).origin}${ENDPOINT}`;

  const missing = await snapshot(routeLog, before);
  if (missing !== undefined) return { problems: [missing] };

  const proc = Bun.spawn([k6, "run", "--quiet", TREND_STATS, "--summary-export", summary, script], {
    env: { ...plainly(process.env), HEALTH_URL: url, CAPACITY_PATH: paths },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
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
  const gone = await snapshot(routeLog, after);

  const measured = capacity(parseSummary(await Bun.file(summary).text()));
  return {
    ...measured,
    log,
    problems: [...measured.problems, ...(gone === undefined ? [] : [gone])],
  };
}
