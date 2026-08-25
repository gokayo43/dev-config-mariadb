import { expect, test } from "bun:test";
import { join } from "node:path";

import { checkout, decoy, ranStep } from "./action-step.ts";
import { lineage, migratesFrom } from "./lineage.ts";
import { DEFAULT as PRODUCT, emptyDatabase, query } from "./servers.ts";
import { materialise } from "./tree.ts";

/**
 * What the shipped replay and DATETIME steps do when the repository they are
 * grading has already had a turn.
 *
 * A gate here runs inside the graded repo's job, after that repo's own install
 * scripts, build and migrator have run — and each of those can write
 * `$GITHUB_ENV` and `$GITHUB_PATH`, which the runner folds into every later
 * step, or leave a file in the checkout that the gate's own interpreter reads
 * on the way up. Four of those reach a gate that takes its cwd, its database,
 * its interpreter or the programs it runs from whatever the environment now
 * holds, and all four end the same way: the step goes green having graded
 * nothing. That is the one outcome a gate may never have, so it is the one this
 * file drives.
 *
 * The harness is `action-step.ts`, shared with `serving-steps.test.ts`: the
 * steps are extracted from the shipped `action.yml` and run, never transcribed.
 *
 * One product under all of them, and that is the whole of the argument for it:
 * what these cases drive is the runner's environment — a cwd, a PATH, an
 * exported variable — which is the same environment whichever server the job
 * started. The cases that are about a server are in `replay.test.ts`,
 * `datetime.test.ts` and `server.test.ts`, and each of those runs against both.
 */

/**
 * The interpreter these cases pin, which is the one running them: what a case
 * asserts is that the step used the path it was handed rather than a name it
 * looked up, and the runner's own bun is not on this box.
 */
const BUN = process.execPath;

/** A database the gate must refuse, so that a green step is always the failure and never the expectation. */
async function ungraded(): Promise<string> {
  const url = await emptyDatabase(PRODUCT);
  await query(url, "create table `booking` (`id` int primary key, `starts_at` datetime)");
  return url;
}

const REFUSES = "booking.starts_at is a DATETIME";

test("the DATETIME gate refuses an unallowlisted column, which every case below is the silencing of", async () => {
  const ran = await ranStep("db-datetime", "Every instant carries its zone", {
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
  const ran = await ranStep("db-datetime", "Every instant carries its zone", {
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
  const elsewhere = await emptyDatabase(PRODUCT);
  await query(elsewhere, "create table `harmless` (`id` int primary key)");

  const ran = await ranStep("db-datetime", "Every instant carries its zone", {
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
  const ran = await ranStep("db-datetime", "Every instant carries its zone", {
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
  const ran = await ranStep("db-datetime", "Every instant carries its zone", {
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
  "database-image": PRODUCT.image,
  "database-url": "mysql://root:db-gate@127.0.0.1:3306/app",
  bun: BUN,
  path: process.env["PATH"] ?? "",
};

test("the replay gate reaches its verdict in a checkout it was not run from", async () => {
  const ran = await ranStep("db-replay", "Replay the migrations", {
    inputs: replayInputs,
    workspace: await checkout(),
  });

  expect(ran.output).toContain(NO_MIGRATOR);
  expect(ran.status).toBe(1);
});

test("a preload in the graded checkout cannot silence the replay gate", async () => {
  const ran = await ranStep("db-replay", "Replay the migrations", {
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
  const ran = await ranStep("db-replay", "Replay the migrations", {
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
  const built = await materialise({
    ...migratesFrom(JOURNALLED, "drizzle"),
    ...lineage("drizzle", CREATES_THING),
  });

  const ran = await ranStep("db-replay", "Replay the migrations", {
    inputs: { ...replayInputs, "database-url": await emptyDatabase(PRODUCT) },
    workspace: built,
    path: await decoy("docker"),
  });

  expect(ran.output).toContain("::notice::replay:");
  expect(ran.status).toBe(0);
  expect(await Bun.file(`${built}/replay-from-empty.schema`).text()).toContain(
    "CREATE TABLE `thing`",
  );
}, 120_000);
