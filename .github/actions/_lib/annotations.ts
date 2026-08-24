// oxlint-disable no-console -- stdout is the protocol: GitHub reads ::error and ::notice lines off it
//
// What a gate under .github/actions writes to the log, and how a step ends.
// GitHub checks the whole repository out to run an action, so a gate may import
// across action directories; only the directory named in `uses:` is the action.
//
// dev-config has a library of this name and shape for its own gates, and this
// is not a copy of it: an action runs from a checkout with no node_modules in
// it, so nothing under .github/actions here can import from the dev-config this
// repo installs. Kept to what the gates here actually write, so the two never
// have to be read side by side.
// dev-config#69 is where publishing this protocol in a form a sibling action
// repo can reach is argued.

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
  // One call rather than a line at a time: the text is already newline-joined,
  // and console.log ends it with the newline the last line would otherwise want.
  if (log !== undefined && log !== "") console.log(log);
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
