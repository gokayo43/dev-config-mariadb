import { afterAll, expect, test } from "bun:test";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { type Foreign, isForeign, isList, mapAt, textAt } from "../.github/actions/_lib/foreign.ts";

import { lineage, migratesFrom } from "./lineage.ts";
import { emptyDatabase, query } from "./mariadb.ts";
import { materialise, type Tree } from "./tree.ts";
import { root } from "./workflow.ts";

/**
 * What the shipped action steps do when the repository they are grading has
 * already had a turn.
 *
 * A gate here runs inside the graded repo's job, after that repo's own install
 * scripts, build and migrator have run — and each of those can write
 * `$GITHUB_ENV` and `$GITHUB_PATH`, which the runner folds into every later
 * step, or leave a file in the checkout that the gate's own interpreter reads
 * on the way up. Three of those reach a gate that takes its cwd, its database
 * and its interpreter from whatever the environment now holds, and all three
 * end the same way: the step goes green having graded nothing. That is the one
 * outcome a gate may never have, so it is the one this file drives.
 *
 * The steps are extracted from the shipped `action.yml` and run, never
 * transcribed — the same reason `refusals.test.ts` gives for the wrapper's own
 * block. A transcription would grade a copy that cannot go stale, which is the
 * opposite of the property wanted.
 */

/** The contexts the runner resolves in a step before it runs, as far as these steps use them. */
interface Context {
  readonly actionPath: string;
  readonly workspace: string;
  readonly temp: string;
  readonly inputs: Readonly<Record<string, string>>;
}

/**
 * One `${{ … }}` as the runner resolves it. Only the handful of references
 * these steps actually carry: an expander that answered everything would be a
 * second implementation of the expression language, and a step reaching for a
 * context this does not know should fail loudly rather than silently expand to
 * nothing.
 */
function resolved(reference: string, context: Context): string {
  const input = /^inputs(?:\.([\w-]+)|\[(['"])([^'"]+)\2\])$/u.exec(reference);
  if (input !== null) {
    const name = input[1] ?? input[3] ?? "";
    const value = context.inputs[name];
    if (value === undefined) throw new Error(`the case passed no ${name} input`);
    return value;
  }
  if (reference === "github.action_path") return context.actionPath;
  if (reference === "github.workspace") return context.workspace;
  if (reference === "runner.temp") return context.temp;
  throw new Error(`this harness does not resolve \${{ ${reference} }}`);
}

function expand(value: string, context: Context): string {
  return value.replaceAll(/\$\{\{\s*(.+?)\s*\}\}/gu, (_, reference: string) =>
    resolved(reference, context),
  );
}

/**
 * The step that runs the gate — the one with a `run:`, since an action may also
 * declare steps that only `uses:` something (db-replay uploads its dumps). Two
 * would mean the gate's own invocation is no longer one thing to drive, which
 * is worth a failure here rather than a case that quietly drove half of it.
 */
function gateStepOf(action: Foreign): Foreign {
  const steps = isList(mapAt(action, "runs")["steps"]) ? mapAt(action, "runs")["steps"] : [];
  const running = (isList(steps) ? steps : []).filter(
    (step) => isForeign(step) && textAt(step, "run") !== undefined,
  );
  const [step, ...rest] = running;
  if (step === undefined || rest.length > 0 || !isForeign(step)) {
    throw new Error(`the action declares ${running.length} steps with a run: block, not one`);
  }
  return step;
}

interface Ran {
  readonly status: number;
  readonly output: string;
}

/**
 * The step, under the runner's own order: the environment it inherited first,
 * then the step's own `env:` over the top. That order is the whole of what
 * makes a step's declared variable beat one an earlier step exported, so a
 * harness that applied it the other way round would pass against the bug.
 */
async function ranStep(
  action: string,
  {
    inputs,
    workspace,
    inherited = {},
    path,
  }: {
    readonly inputs: Readonly<Record<string, string>>;
    readonly workspace: string;
    readonly inherited?: Readonly<Record<string, string>>;
    readonly path?: string;
  },
): Promise<Ran> {
  const actionPath = `${root}/.github/actions/${action}`;
  const parsed: unknown = Bun.YAML.parse(await Bun.file(`${actionPath}/action.yml`).text());
  if (!isForeign(parsed)) throw new Error(`${action}/action.yml did not parse as a mapping`);
  const step = gateStepOf(parsed);
  const context: Context = { actionPath, workspace, temp: workspace, inputs };

  const env = mapAt(step, "env");
  const declared = Object.fromEntries(
    Object.keys(env).map((name) => {
      const value = textAt(env, name);
      if (value === undefined)
        throw new Error(`${action}'s step maps ${name} to something not text`);
      return [name, expand(value, context)];
    }),
  );
  const where = textAt(step, "working-directory");
  const script = textAt(step, "run");
  if (script === undefined) throw new Error(`${action}'s step declares no run block`);

  const proc = Bun.spawn(["bash", "-c", script], {
    // Resolved against the checkout, which is what the runner does with a
    // relative one and the whole of what a step declaring none inherits — a
    // harness that read it any other way would report a step running somewhere
    // it never runs.
    cwd: where === undefined ? workspace : resolve(workspace, expand(where, context)),
    env: {
      ...process.env,
      ...(path === undefined ? {} : { PATH: `${path}:${process.env["PATH"] ?? ""}` }),
      GITHUB_ACTION_PATH: actionPath,
      GITHUB_WORKSPACE: workspace,
      ...inherited,
      ...declared,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status: await proc.exited, output: out + err };
}

/** A checkout of the repository under grade, holding whatever this case says it holds. */
async function checkout(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const where = await mkdtemp(join(tmpdir(), "graded-"));
  made.push(where);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(`${where}/${name}`, content);
  }
  return where;
}

/**
 * A project on disk, torn down by THIS file.
 *
 * `tree.ts` registers an `afterEach` of its own, but a hook at the top level of
 * an imported module attaches to whichever test FILE imported it first — the
 * trap `mariadb.ts` describes at length — so a root materialised from here is
 * removed only on a run that happens to reach this file before `replay.test.ts`.
 * Proven: this file alone leaves nothing behind, and the whole suite left one
 * project per run. Removing it from what this file already removes is
 * independent of which files a run includes.
 */
async function project(tree: Tree): Promise<string> {
  const where = await materialise(tree);
  made.push(where);
  return where;
}

const made: string[] = [];

afterAll(async () => {
  for (const where of made.splice(0)) await rm(where, { recursive: true, force: true });
});

/**
 * A directory holding a program of that name which does nothing and reports
 * success, which is the whole of what a hijacked PATH buys: every case below
 * that uses one is asking whether the step reached the real program instead.
 */
async function decoy(name: string): Promise<string> {
  const where = await checkout({ [name]: "#!/bin/sh\nexit 0\n" });
  await Bun.spawn(["chmod", "+x", `${where}/${name}`]).exited;
  return where;
}

/**
 * The interpreter these cases pin, which is the one running them: what a case
 * asserts is that the step used the path it was handed rather than a name it
 * looked up, and the runner's own bun is not on this box.
 */

const BUN = process.execPath;

/** A database the gate must refuse, so that a green step is always the failure and never the expectation. */
async function ungraded(): Promise<string> {
  const url = await emptyDatabase();
  await query(url, "create table `booking` (`id` int primary key, `starts_at` datetime)");
  return url;
}

const REFUSES = "booking.starts_at is a DATETIME";

test("the DATETIME gate refuses an unallowlisted column, which every case below is the silencing of", async () => {
  const ran = await ranStep("db-datetime", {
    inputs: { "datetime-allowlist": "", "database-url": await ungraded(), bun: BUN },
    workspace: await checkout(),
  });

  expect(ran.output).toContain(REFUSES);
  expect(ran.status).toBe(1);
}, 60_000);

/**
 * `bun` reads a top-level `preload` out of the `bunfig.toml` in its working
 * directory and runs it before the file it was given, so a gate whose cwd is
 * the graded checkout runs that repo's code first — `process.exit(0)` there
 * ends the step green with the gate never having been reached. Probed on the
 * pinned bun: only the working directory is read, no parent is walked, and no
 * global file is read, so an action running in its own checkout is out of that
 * repo's reach entirely.
 *
 * A consumer need not be hostile for this to matter, which is why it is a
 * blocker rather than a hardening: a legitimate preload injects the same way.
 */
test("a preload in the graded checkout cannot silence the DATETIME gate", async () => {
  const ran = await ranStep("db-datetime", {
    inputs: { "datetime-allowlist": "", "database-url": await ungraded(), bun: BUN },
    workspace: await checkout({
      "bunfig.toml": 'preload = ["./silence.ts"]\n',
      "silence.ts": "process.exit(0);\n",
    }),
  });

  expect(ran.output).toContain(REFUSES);
  expect(ran.status).toBe(1);
}, 60_000);

/**
 * A step of the graded repo's own — an install script, the migrator — writes
 * `DATABASE_URL=…` into `$GITHUB_ENV`, and the runner hands that to every later
 * step. A gate reading the variable it inherited would then grade whichever
 * database that repo pointed it at: an empty one is refused, so the shape that
 * passes is a decoy holding one harmless table.
 *
 * The step declaring the variable in its own `env:` is what beats it, and the
 * harness applies the two in the runner's order so that this case can tell the
 * difference.
 */
test("a DATABASE_URL exported by the graded repo cannot redirect the DATETIME gate", async () => {
  const elsewhere = await emptyDatabase();
  await query(elsewhere, "create table `harmless` (`id` int primary key)");

  const ran = await ranStep("db-datetime", {
    inputs: { "datetime-allowlist": "", "database-url": await ungraded(), bun: BUN },
    workspace: await checkout(),
    inherited: { DATABASE_URL: elsewhere },
  });

  expect(ran.output).toContain(REFUSES);
  expect(ran.status).toBe(1);
}, 60_000);

/**
 * The same move against `$GITHUB_PATH`, and the worse half of it: a directory
 * prepended there puts the graded repo's own `bun` ahead of the runner's, and
 * the gate's code never runs at all. An absolute interpreter is not on that
 * path to be replaced.
 */
test("a bun the graded repo put on PATH cannot replace the DATETIME gate's interpreter", async () => {
  const ran = await ranStep("db-datetime", {
    inputs: { "datetime-allowlist": "", "database-url": await ungraded(), bun: BUN },
    workspace: await checkout(),
    path: await decoy("bun"),
  });

  expect(ran.output).toContain(REFUSES);
  expect(ran.status).toBe(1);
}, 60_000);

/**
 * `required: true` on a composite action's input is a promise nothing enforces:
 * a caller who omits it gets the empty string, and an empty interpreter is a
 * `command not found` naming nothing. The step says which input is missing
 * instead.
 */
test("the DATETIME gate refuses to run without the interpreter its caller pins", async () => {
  const ran = await ranStep("db-datetime", {
    inputs: { "datetime-allowlist": "", "database-url": await ungraded(), bun: "" },
    workspace: await checkout(),
  });

  expect(ran.output).toContain("::error::the bun input is empty");
  expect(ran.status).toBe(1);
}, 60_000);

/**
 * The same class in the sibling gate, which had the same shape and must lose it
 * in the same change.
 *
 * A checkout with no `package.json` is refused before this gate opens a
 * connection, so these cases need no server: what they assert is that the
 * gate's own code ran and said so, which is exactly what each attack above
 * prevents.
 */
const NO_MIGRATOR = "declares no db:migrate script";

/**
 * Drizzle's own MySQL migrator, which is what the replay suite drives wherever
 * a case needs the second replay to be the no-op a journal makes it.
 */
const JOURNALLED = join(import.meta.dir, "journalled-migrator.ts");

const CREATES_THING = {
  tag: "0000_thing",
  when: 1_000,
  sql: "CREATE TABLE `thing` (\n\t`id` int NOT NULL,\n\tCONSTRAINT `thing_id` PRIMARY KEY(`id`)\n);\n",
};

const replayInputs = {
  "working-directory": ".",
  "db-image": "mariadb:11.4",
  "db-gate-evidence": "",
  "database-url": "mysql://root:mariadb@127.0.0.1:3306/app",
  bun: BUN,
  path: process.env["PATH"] ?? "",
};

test("the replay gate reaches its verdict in a checkout it was not run from", async () => {
  const ran = await ranStep("db-replay", { inputs: replayInputs, workspace: await checkout() });

  expect(ran.output).toContain(NO_MIGRATOR);
  expect(ran.status).toBe(1);
});

test("a preload in the graded checkout cannot silence the replay gate", async () => {
  const ran = await ranStep("db-replay", {
    inputs: replayInputs,
    workspace: await checkout({
      "bunfig.toml": 'preload = ["./silence.ts"]\n',
      "silence.ts": "process.exit(0);\n",
    }),
  });

  expect(ran.output).toContain(NO_MIGRATOR);
  expect(ran.status).toBe(1);
});

test("a bun the graded repo put on PATH cannot replace the replay gate's interpreter", async () => {
  const ran = await ranStep("db-replay", {
    inputs: replayInputs,
    workspace: await checkout(),
    path: await decoy("bun"),
  });

  expect(ran.output).toContain(NO_MIGRATOR);
  expect(ran.status).toBe(1);
});

/**
 * The same move one layer down, and the layer the interpreter pin does not
 * reach: this gate takes its two schema dumps by running `docker`, resolved by
 * name, and the image digest pins which image runs rather than which program is
 * asked to run it. A `docker` early on PATH that exits 0 with nothing on stdout
 * hands the gate two empty dumps — which are identical, which is the whole of
 * what this gate asserts. Green, over a schema it never read.
 *
 * So the assertion is on the evidence rather than on the exit code: an honest
 * project passes either way, and the two are told apart by whether the dump the
 * step left behind holds the table the migrations built.
 */
test("a docker the graded repo put on PATH cannot take the replay gate's dumps", async () => {
  const built = await project({
    ...migratesFrom(JOURNALLED, "drizzle"),
    ...lineage("drizzle", CREATES_THING),
  });

  const ran = await ranStep("db-replay", {
    inputs: { ...replayInputs, "database-url": await emptyDatabase() },
    workspace: built,
    path: await decoy("docker"),
  });

  expect(ran.output).toContain("::notice::replay:");
  expect(ran.status).toBe(0);
  expect(await Bun.file(`${built}/replay-from-empty.schema`).text()).toContain(
    "CREATE TABLE `thing`",
  );
}, 120_000);
