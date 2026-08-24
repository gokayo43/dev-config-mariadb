import { expect, test } from "bun:test";
import { join } from "node:path";

import type { Verdict } from "../.github/actions/_lib/annotations.ts";
import { textAt } from "../.github/actions/_lib/foreign.ts";
import { replayGate } from "../.github/actions/db-replay/replay.ts";

import { lineage, migratesFrom, type Migration, scripted } from "./lineage.ts";
import { emptyDatabase, IMAGE, query } from "./mariadb.ts";
import { materialise, type Tree, without } from "./tree.ts";

/**
 * A real MariaDB and a real migrator per case, because every property this gate
 * asserts is a property of what a database ends up holding. A second replay
 * that quietly changed the schema is visible in one place only — the server's
 * own catalogue, rendered by the server's own client — so a stand-in for either
 * would be grading the stand-in.
 *
 * The migrator is drizzle's real MySQL one wherever the case is about a
 * journal, and a hand-rolled runner wherever it is about SQL that runs twice.
 * `mariadb.ts` is the server; `tree.ts` is the project on disk.
 */

const JOURNALLED = join(import.meta.dir, "journalled-migrator.ts");
const REPLAYING = join(import.meta.dir, "replaying-migrator.ts");

const CREATES_THING: Migration = {
  tag: "0000_thing",
  when: 1_000,
  sql: "CREATE TABLE `thing` (\n\t`id` int NOT NULL,\n\tCONSTRAINT `thing_id` PRIMARY KEY(`id`)\n);\n",
};

const ADDS_SLUG: Migration = {
  tag: "0001_slug",
  when: 2_000,
  sql: "ALTER TABLE `thing` ADD `slug` varchar(80);\n",
};

/** Where a run leaves the two schemas it compared, per case. */
interface Evidence {
  readonly fromEmpty: string;
  readonly replayed: string;
}

interface Ran {
  readonly verdict: Verdict;
  readonly url: string;
  readonly evidence: Evidence;
}

async function run(tree: Tree): Promise<Ran> {
  const root = await materialise(tree);
  const url = await emptyDatabase();
  const evidence = {
    fromEmpty: join(root, "from-empty.schema"),
    replayed: join(root, "replayed.schema"),
  };
  return { verdict: await replayGate({ root, url, image: IMAGE, ...evidence }), url, evidence };
}

/** What the gate threw, as the text a case can read: a rejection is the diagnostic here. */
async function refusal(tree: Tree): Promise<string> {
  try {
    await run(tree);
    return "the gate returned a verdict instead of throwing";
  } catch (thrown) {
    return String(thrown);
  }
}

/** The tables in the database a URL names, asked of the server rather than of the gate. */
async function names(at: string): Promise<string[]> {
  const answered = await query(
    at,
    "select table_name as name from information_schema.tables where table_schema = database()",
  );
  return answered.map((row) => textAt(row, "name") ?? "(no name)");
}

test("a lineage that rebuilds the schema from empty, twice, passes", async () => {
  const { verdict, evidence } = await run({
    ...migratesFrom(JOURNALLED, "drizzle"),
    ...lineage("drizzle", CREATES_THING, ADDS_SLUG),
  });

  expect(verdict.problems).toEqual([]);
  expect(verdict.log).toBeUndefined();
  expect(verdict.note).toContain("replaying them leaves it identical");
  // The schema is what the dumps carry, and it is the migrations' rather than
  // an empty file that happened to match another empty file.
  expect(await Bun.file(evidence.fromEmpty).text()).toContain("CREATE TABLE `thing`");
  expect(await Bun.file(evidence.replayed).text()).toContain("`slug` varchar(80)");
}, 60_000);

// The shape the whole gate leads with: a migration that only applies to a
// database somebody has already migrated. It succeeded where it was written,
// against a table a later migration has since dropped, and aborts the first time
// the history runs onto nothing.
test("a lineage that cannot rebuild from empty is refused, and leaves no schema behind as evidence", async () => {
  const tree = {
    ...migratesFrom(JOURNALLED, "drizzle"),
    ...lineage(
      "drizzle",
      CREATES_THING,
      { tag: "0001_drop", when: 2_000, sql: "DROP TABLE `thing`;\n" },
      {
        tag: "0002_alter",
        when: 3_000,
        sql: "ALTER TABLE `thing` ADD `slug` varchar(80);\n",
      },
    ),
  };

  expect(await refusal(tree)).toContain("failed building");
  expect(await refusal(tree)).toContain("aborts here");
}, 90_000);

/**
 * The case the exit code cannot decide, and the reason the verdict is a dump.
 *
 * The most plausible wrong implementation of "replay it twice" is to run the
 * migrator again and read its status. This tree passes that: the runner has no
 * journal, `CREATE TABLE IF NOT EXISTS` is quiet on the second pass, and an
 * unnamed CHECK is accepted again under a name of the server's choosing — so
 * the second run exits 0 having left a constraint behind that the first did not.
 * Only reading the schema back sees it.
 */
test("a second replay that changes the schema is refused, naming the lines that differ", async () => {
  const { verdict, evidence } = await run({
    ...migratesFrom(REPLAYING, "drizzle"),
    ...lineage("drizzle", {
      tag: "0000_thing",
      when: 1_000,
      sql: "CREATE TABLE IF NOT EXISTS `thing` (`id` int);\nALTER TABLE `thing` ADD CHECK (`id` > 0);\n",
    }),
  });

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain("changed");
  expect(verdict.problems[0]).toContain("must not depend on how many times it was migrated");
  expect(verdict.note).toBeUndefined();
  // Never a refusal with nothing to show for itself: the log carries the line
  // the second replay added, under the schema that has it.
  expect(verdict.log).toContain("the schema after a second replay, from line ");
  expect(verdict.log).toContain("CONSTRAINT_2");
  // The line number reaches the annotation too, so a reader who sees only the
  // step's error knows where in the artifact's dumps to look.
  expect(verdict.problems[0]).toContain("first differ at line ");
  // Both dumps are on disk, because each is written as it is taken rather
  // than after a comparison that may never happen.
  expect(await Bun.file(evidence.fromEmpty).exists()).toBe(true);
  expect(await Bun.file(evidence.replayed).exists()).toBe(true);
}, 60_000);

/**
 * The other half of that rule, and the reason `AUTO_INCREMENT=<n>` is taken out
 * of the dump. This runner applies its insert on every pass, so the counter is
 * at 2 when the first schema is read and at 3 when the second is — while the
 * schema itself has not moved. A gate comparing the raw dumps refuses this repo
 * over a number that means how many rows have been written.
 */
test("rows written by a second replay do not read as a schema change", async () => {
  const { verdict } = await run({
    ...migratesFrom(REPLAYING, "drizzle"),
    ...lineage("drizzle", {
      tag: "0000_thing",
      when: 1_000,
      sql: "CREATE TABLE IF NOT EXISTS `thing` (`id` int NOT NULL AUTO_INCREMENT PRIMARY KEY, `name` varchar(80));\nINSERT INTO `thing` (`name`) VALUES ('a');\n",
    }),
  });

  expect(verdict.problems).toEqual([]);
  expect(verdict.note).toContain("replaying them leaves it identical");
}, 60_000);

/**
 * SF1, first member. A sequence's position is rendered into a `--no-data` dump
 * as `DO SETVAL(<seq>, <next>, <cycles>)`, and a migration that consumes a
 * value moves it — by a thousand, since a sequence's default cache is 1000. The
 * schema is untouched either way, so a gate comparing the raw dumps refuses
 * this repo over how many ids have been handed out.
 */
test("consuming a sequence value is not a schema change", async () => {
  // NOCACHE so every NEXTVAL moves the stored position. With the default cache
  // of 1000 the move happens only when a replay crosses the cache boundary,
  // which is a real way to hit this and a useless way to test it.
  const { verdict } = await run({
    ...migratesFrom(REPLAYING, "drizzle"),
    ...lineage("drizzle", {
      tag: "0000_seq",
      when: 1_000,
      sql: "CREATE SEQUENCE IF NOT EXISTS `counter` NOCACHE;\nSELECT NEXTVAL(`counter`);\n",
    }),
  });

  expect(verdict.problems).toEqual([]);
  expect(verdict.note).toContain("replaying them leaves it identical");
}, 60_000);

/**
 * SF1, second member. `DROP EVENT IF EXISTS` before `CREATE EVENT` is the
 * idiomatic way to write a re-runnable migration for one — and an event with no
 * explicit STARTS is stamped with its creation time, so the second replay
 * re-creates it and re-stamps it. The event is the same event; only the stamp
 * moved.
 */
test("re-creating an event does not read as a schema change", async () => {
  // The sleep is what makes the case deterministic rather than a coin flip:
  // STARTS has one-second resolution, and the two replays are otherwise
  // separated only by however long a dump takes.
  const { verdict } = await run({
    ...migratesFrom(REPLAYING, "drizzle"),
    ...lineage("drizzle", {
      tag: "0000_event",
      when: 1_000,
      sql: "DO SLEEP(1.1);\nDROP EVENT IF EXISTS `sweep`;\nCREATE EVENT `sweep` ON SCHEDULE EVERY 1 DAY DO SELECT 1;\n",
    }),
  });

  expect(verdict.problems).toEqual([]);
  expect(verdict.note).toContain("replaying them leaves it identical");
}, 60_000);

/**
 * The second of the two refusals the ticket names, and the branch with its own
 * bespoke diagnostic. A runner with no journal re-executes every file, so a
 * `CREATE TABLE` without `IF NOT EXISTS` applies once and aborts on the replay
 * — a different fault from a history that cannot build from empty, and it says
 * which of the two runs failed.
 */
test("a migration that cannot be applied twice is refused, naming which run failed", async () => {
  const refused = await refusal({
    ...migratesFrom(REPLAYING, "drizzle"),
    ...lineage("drizzle", {
      tag: "0000_thing",
      when: 1_000,
      sql: "CREATE TABLE `thing` (`id` int NOT NULL);\n",
    }),
  });

  expect(refused).toContain("failed on its second run");
  expect(refused).toContain("having just succeeded on its first");
  expect(refused).toContain("cannot be applied twice");
}, 90_000);

test("an empty db-image is refused before any migration runs", async () => {
  const root = await materialise({
    ...migratesFrom(JOURNALLED, "drizzle"),
    ...lineage("drizzle", CREATES_THING),
  });
  const url = await emptyDatabase();

  const verdict = await replayGate({
    root,
    url,
    image: "",
    fromEmpty: join(root, "from-empty.schema"),
    replayed: join(root, "replayed.schema"),
  });

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain("db-image input is empty");
  // Refused before the migrator ran, rather than after two replays.
  expect(await names(url)).toEqual([]);
}, 60_000);

test("a project that declares no db:migrate is refused rather than replayed", async () => {
  const { verdict } = await run(
    without(
      { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING) },
      "package.json",
    ),
  );

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain("declares no db:migrate script");
  expect(verdict.problems[0]).toContain("nothing to replay");
}, 60_000);

test("a db:migrate that is not a migrator at all is refused", async () => {
  const { verdict } = await run({ ...scripted("true"), ...lineage("drizzle", CREATES_THING) });

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain("no schema in it");
}, 60_000);

/**
 * The refusal that needs the journal's spelling to be right.
 *
 * drizzle's MySQL migrator keeps `__drizzle_migrations` in the database it is
 * migrating, with no schema qualifier — its Postgres migrator puts the same
 * table in a schema of its own. So a lineage that builds nothing still leaves
 * one table behind, and a gate counting tables to decide whether anything was
 * built passes this repo on the migrator's own bookkeeping.
 */
test("a lineage that applies but builds nothing is refused, journal table and all", async () => {
  const { verdict, url } = await run({
    ...migratesFrom(JOURNALLED, "drizzle"),
    ...lineage("drizzle", { tag: "0000_nothing", when: 1_000, sql: "SELECT 1;\n" }),
  });

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain("no schema in it");
  // The database is not empty: the migrator ran and recorded that it had.
  expect(await names(url)).toEqual(["__drizzle_migrations"]);
}, 60_000);

/**
 * The false refusal the exclusion above must not cause. A migration set that
 * builds only a stored routine has built something, and a gate reading tables
 * alone would send its author hunting for a lineage that is there.
 */
test("a lineage that builds only a routine has built a schema", async () => {
  const { verdict, evidence } = await run({
    ...migratesFrom(JOURNALLED, "drizzle"),
    ...lineage("drizzle", {
      tag: "0000_routine",
      when: 1_000,
      sql: "CREATE PROCEDURE `p_thing`() SELECT 1;\n",
    }),
  });

  expect(verdict.problems).toEqual([]);
  expect(await Bun.file(evidence.fromEmpty).text()).toContain("p_thing");
}, 60_000);

test("a database something has already been in is refused before anything is replayed", async () => {
  const root = await materialise({
    ...migratesFrom(JOURNALLED, "drizzle"),
    ...lineage("drizzle", CREATES_THING),
  });
  const url = await emptyDatabase();
  await query(url, "create table `already` (`id` int)");

  const verdict = await replayGate({
    root,
    url,
    image: IMAGE,
    fromEmpty: join(root, "from-empty.schema"),
    replayed: join(root, "replayed.schema"),
  });

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain("already holds 1 object (already)");
  // Refused before the migrator ran, so the tree's own lineage never touched it.
  expect(await names(url)).toEqual(["already"]);
}, 60_000);
