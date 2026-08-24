// oxlint-disable no-console -- stdout is the protocol: GitHub reads ::error and ::notice lines off it
//
// What a gate under .github/actions writes to the log, and how a step ends.
// GitHub checks the whole repository out to run an action, so a gate may import
// across action directories; only the directory named in `uses:` is the action.
//
// **This is a checked-in copy of dev-config's `.github/actions/_lib/gate.ts` at
// the pinned SHA**, cut down to what the gates here write. `inputs` and
// `required` are theirs verbatim; `commanded`, `publish` and `entry` are theirs
// with the deltas named below. It is a copy because there is no import that
// could reach the original: an action runs from a checkout with no node_modules
// above it, and `.github/` sits outside dev-config's `files` allowlist, so the
// only copy on disk anywhere is in a consuming repo's workspace rather than in
// the action's. dev-config#69 is where publishing it in a reachable form is
// argued; CLAUDE.md's "It only adds" rule carries the carve-out that lets this
// file exist. A bug fixed there is a bug still here until somebody carries it
// over — and one of them has already been fixed here and not there, see `entry`.
//
// Deltas from upstream, all deliberate:
//   * `Verdict.problems` is `readonly string[]` rather than their `Problem[]`.
//     Every problem this repo's gates raise is about a database rather than
//     about a line of the tree, and `file=`/`line=` on an annotation that
//     pointed at nothing would be dropped by GitHub in silence.
//   * `publish` is synchronous and writes no run summary: no gate here
//     publishes a table yet.
//   * `entry` escapes the caught error — see there.
//   * `publish` relays the log through `relay` rather than printing it — see
//     there. Upstream prints it raw, which is dev-config#71's second half.

/**
 * What a gate answers with. `problems` is what fails the step, `log` is the
 * evidence too long to be an annotation — every line two schemas disagree
 * about — and `note` is the one line a green run leaves behind.
 *
 * The three are optional rather than nullable, which under
 * `exactOptionalPropertyTypes` is the difference between a field a gate left out
 * and one it filled with nothing.
 */
export interface Verdict {
  readonly note?: string;
  readonly log?: string;
  readonly problems: readonly string[];
}

/**
 * A message as a workflow command carries it.
 *
 * GitHub reads one command per line, so a newline inside a message ends the
 * annotation and offers whatever follows to the parser as a command in its own
 * right. What the gates here quote — a line of a schema dump, a table name, a
 * path — comes off the repository under grade, so it is not the gate author's
 * to trust, and a value holding `\n::add-mask::` would be obeyed rather than
 * shown.
 *
 * Percent first, or the escapes the other two introduce would be escaped again
 * and arrive as `%250A`. Only the three characters GitHub decodes: this is its
 * encoding, and anything else escaped here arrives visibly wrong.
 */
function commanded(message: string): string {
  return message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

/**
 * The margin every relayed line carries.
 *
 * Not decoration. The runner reads its own commands off this stdout, matching
 * `::` after trimming the line's leading whitespace — so any line whose first
 * non-blank characters are `::` is a command it obeys, whoever wrote it. What
 * this repo relays is a schema dump and a consuming repo's migrator output,
 * both of which carry text the graded repo chose: a routine body holding a
 * newline and `::stop-commands::` reaches the log as a line of its own, and
 * from there the gate's own annotations stop rendering. The step still fails,
 * so no verdict is flipped — it goes red with nothing shown, which is the one
 * outcome no gate here may produce.
 *
 * A leading `| ` cannot be trimmed away and is not `::`, so the class is dead
 * at this one choke point rather than at each caller. Indenting was not enough
 * and never could be: whitespace is exactly what the runner removes first.
 */
const MARGIN = "| ";

/**
 * Output this repo did not write, put on the log without letting it speak to
 * the runner. Line by line, because the evidence is multi-line and its shape is
 * the point — a single escaped blob would arrive as one unreadable line.
 *
 * `commanded` is deliberately NOT applied: these lines are plain stdout rather
 * than the body of a workflow command, so GitHub decodes no escapes in them and
 * a `%` run through it would render as `%25`.
 */
export function relay(output: string): void {
  const lines = output.split("\n");
  // A trailing newline is a line ending, not an empty last line to print.
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) console.log(`${MARGIN}${line}`);
}

/**
 * The whole of what a `*.main.ts` does with a verdict, here rather than in each
 * entry point because the order of the writes is load-bearing: what the run
 * wrote goes out first, then the annotations summarising it, so a reader who
 * scrolls to the error finds the evidence for it above rather than somewhere
 * below.
 *
 * Every problem is annotated and the step fails once. A gate that exited at the
 * first violation would cost a full CI round-trip per fix, and a bare non-zero
 * exit points at the workflow rather than at what has to change.
 */
export function publish({ log, note, problems }: Verdict): void {
  if (log !== undefined && log !== "") relay(log);
  if (note !== undefined && note !== "") console.log(`::notice::${commanded(note)}`);
  for (const problem of problems) console.log(`::error::${commanded(problem)}`);
  if (problems.length > 0) process.exitCode = 1;
}

/**
 * The work a `*.main.ts` hands over, so that a gate which throws — an input the
 * action forgot to pass, a database refusing the connection, a dump tool that is
 * not there — reaches the log as the annotation GitHub renders on the step
 * rather than as a stack trace in the raw output.
 *
 * It exits rather than returning, because a gate that died mid-read may be
 * holding something that keeps the runtime alive, and a step waiting on that
 * costs the job's whole timeout to say what it already knows.
 *
 * **The `commanded` call below is a deliberate divergence from dev-config**,
 * whose `entry` writes the caught message raw. A thrown message here quotes
 * what the gate read off the repository under grade — a database name, a path,
 * a line of a dump — so it is not the gate author's to trust, and GitHub ends a
 * workflow command at the newline: a message carrying one followed by
 * `::add-mask::` is a command the runner obeys rather than text it renders.
 * Every path in this file that writes a workflow command escapes its message,
 * and this is one of them; the path that writes plain output instead goes
 * through `relay`, which is a different defence against the same class.
 * dev-config#71 is both holes upstream.
 */
export async function entry(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.log(`::error::${commanded(error instanceof Error ? error.message : String(error))}`);
    process.exit(1);
  }
}

/**
 * The inputs the calling action.yml promises to set. A missing one is a wiring
 * bug in the action, and a gate that defaulted it silently would grade every
 * repo against a contract nobody chose.
 */
export function inputs<const Names extends readonly string[]>(
  ...names: Names
): Record<Names[number], string> {
  const read = names.map((name) => {
    const variable = `INPUT_${name.toUpperCase().replaceAll("-", "_")}`;
    const value = Bun.env[variable];
    if (value === undefined) throw new Error(`${variable} is not set — the action must pass it`);
    return [name, value];
  });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fromEntries answers a string-keyed record; that its keys are exactly `names` is what the signature promises and what no inference can express
  return Object.fromEntries(read) as Record<Names[number], string>;
}

/**
 * An environment variable the calling job owns, refused rather than defaulted.
 * The reason travels with the call because two gates reading one variable are
 * left holding different things when it is missing, and each should say which.
 */
export function required(name: string, why: string): string {
  const value = Bun.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set — ${why}`);
  return value;
}
