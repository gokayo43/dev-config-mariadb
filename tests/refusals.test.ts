import { expect, test } from "bun:test";

import { isList, mapAt, textAt } from "../.github/actions/_lib/foreign.ts";

import { root, WRAPPER, wrapperDocument } from "./workflow.ts";

/**
 * The one behavioural rule the wrapper itself adds, rather than delegating: a
 * call that asks for an input aimed at the replay job without asking for the
 * job is refused instead of ignored. Being quietly ignored is how a gate
 * somebody asked for turns out never to have run, and this is the only place
 * that rule exists.
 *
 * The suite runs the shipped `run:` block rather than a transcription of it,
 * the way dev-config's test-suite suite runs its action's. A copy could not
 * grade the thing worth grading — whether the block the workflow actually ships
 * refuses what it claims to — and would go green against a workflow that had
 * stopped carrying it at all.
 */
const STEP = await (async (): Promise<string> => {
  const jobs = mapAt(await wrapperDocument(), "jobs");
  const steps = mapAt(jobs, "refusals")["steps"];
  const scripts = (isList(steps) ? steps : [])
    .map((step) => textAt(step, "run"))
    .filter((run): run is string => run !== undefined);
  const [script, ...rest] = scripts;
  if (script === undefined || rest.length > 0) {
    throw new Error(
      `${WRAPPER} must have a 'refusals' job with exactly one run step, and has ${scripts.length} — that job is the only thing refusing a database-job input passed without the job`,
    );
  }
  return script;
})();

interface Ran {
  readonly status: number;
  readonly output: string;
}

/** The step under bash, with the two variables its `env:` block maps in. */
async function ran(database: string, evidence: string): Promise<Ran> {
  const proc = Bun.spawn(["bash", "-c", STEP], {
    cwd: root,
    env: { ...process.env, DATABASE: database, DB_GATE_EVIDENCE: evidence },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status: await proc.exited, output: out + err };
}

/**
 * The whole truth table, because the interesting half of this rule is what it
 * does NOT refuse. A guard that fires on every call is one somebody turns off,
 * and a guard that fires on the combination a consumer legitimately writes —
 * the input, with the job it belongs to — would refuse the only correct way to
 * use it.
 */
test("the evidence name is refused only when the job that would upload it is off", async () => {
  const refused = await ran("false", "db-replay-evidence-mariadb");

  expect(refused.status).toBe(1);
  expect(refused.output).toContain("::error::db-gate-evidence needs database: true");
  expect(refused.output).toContain("names the artifact the replay job uploads");
});

test("asking for the job and the artifact name together is what the input is for", async () => {
  const allowed = await ran("true", "db-replay-evidence-mariadb");

  expect(allowed.status).toBe(0);
  expect(allowed.output).not.toContain("::error::");
});

test("a call that asks for neither passes, which is every consumer that has not adopted", async () => {
  const quiet = await ran("false", "");

  expect(quiet.status).toBe(0);
  expect(quiet.output).not.toContain("::error::");
});

test("a call that asks for the job and lets the artifact name default passes", async () => {
  const defaulted = await ran("true", "");

  expect(defaulted.status).toBe(0);
  expect(defaulted.output).not.toContain("::error::");
});

/**
 * The step is written so that its body is the rule and its `if:` is nothing —
 * a condition restating what the body tests is a second statement of one rule,
 * and the half that gets forgotten is the guard. That only holds while the job
 * really has no condition on it.
 */
test("the refusals job runs on every call, so the rule cannot be skipped", async () => {
  const refusals = mapAt(mapAt(await wrapperDocument(), "jobs"), "refusals");

  expect(Object.keys(refusals)).not.toContain("if");
  expect(Object.keys(refusals)).not.toContain("needs");
});
