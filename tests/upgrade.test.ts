import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { upgradeGate } from "../.github/actions/db-upgrade/upgrade.ts";

import { lineage, migratesFrom, type Migration } from "./lineage.ts";
import { PRODUCTS, emptyDatabase, query } from "./servers.ts";
import { committed, type Repo } from "./repo.ts";
import { type Tree } from "./tree.ts";

/**
 * The property the replay gate cannot reach, against a real server and a real
 * git history: a database built by upgrading equals a database built fresh.
 *
 * Every case here is a repository rather than a directory — the gate reads the
 * base ref out of git and rolls the lineage back to it, so a fixture without
 * history would be grading nothing. `repo.ts` is what makes one and commits to
 * it; the migrator is drizzle's own, because what is under test is exactly what
 * that migrator does with a migration it has already applied.
 *
 * Both products, for the reason every server-touching suite here runs against
 * both: the verdict rests on two dumps taken by the image's own client, and the
 * journal it reads back is the one the MySQL family keeps per database.
 */

const JOURNALLED = join(import.meta.dir, "journalled-migrator.ts");

const CREATES_THING: Migration = {
  tag: "0000_thing",
  when: 1_000,
  sql: "CREATE TABLE `thing` (\n\t`id` int NOT NULL,\n\tCONSTRAINT `thing_id` PRIMARY KEY(`id`)\n);\n",
};

/** The migration a well-behaved branch adds: a new file, after the ones that have run. */
const ADDS_SLUG: Migration = {
  tag: "0001_slug",
  when: 2_000,
  sql: "ALTER TABLE `thing` ADD `slug` varchar(80);\n",
};

/** What every case starts from: one applied migration, as the base ref carries it. */
function deployed(): Tree {
  return { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING) };
}

for (const product of PRODUCTS) {
  describe(product.name, () => {
    /**
     * The gate against a fresh database this case's own branch built, which is
     * what an upgrade has to arrive at — so every case migrates the fresh
     * database first, exactly as the replay step does before this one runs.
     */
    async function ran(repo: Repo): Promise<{ problems: readonly string[]; note?: string }> {
      const url = await emptyDatabase(product);
      await repo.migrate(url);
      return await upgradeGate({
        root: repo.root,
        url,
        image: product.image,
        event: { baseRef: "", before: "" },
        upgraded: join(repo.root, "upgraded.schema"),
      });
    }

    test("a branch that adds a migration reaches the schema a fresh database gets", async () => {
      const repo = await committed(deployed(), {
        ...deployed(),
        ...lineage("drizzle", CREATES_THING, ADDS_SLUG),
      });

      const verdict = await ran(repo);

      expect(verdict.problems).toEqual([]);
      expect(verdict.note).toContain("reaches the schema a fresh one gets");
      // The upgraded schema is on disk whichever way the comparison went.
      expect(await Bun.file(join(repo.root, "upgraded.schema")).exists()).toBe(true);
    }, 120_000);

    /**
     * The whole reason this gate exists, and the failure no exit code reports:
     * the column is added to the migration that already ran rather than in a new
     * file. A fresh database gets it. A deployed one never re-reads that file,
     * so it gets nothing — and drizzle's migrator exits 0 either way, having
     * compared the journal's high-water mark and found nothing to do.
     *
     * The most plausible wrong implementation of the whole gate is one that
     * replays the branch's own lineage twice and compares that with itself: it
     * passes this case, because both halves would carry the edit.
     */
    test("editing a migration that has already been applied is refused", async () => {
      const repo = await committed(deployed(), {
        ...migratesFrom(JOURNALLED, "drizzle"),
        ...lineage("drizzle", {
          ...CREATES_THING,
          sql: "CREATE TABLE `thing` (\n\t`id` int NOT NULL,\n\t`slug` varchar(80),\n\tCONSTRAINT `thing_id` PRIMARY KEY(`id`)\n);\n",
        }),
      });

      const verdict = await ran(repo);

      expect(verdict.problems).toHaveLength(1);
      expect(verdict.problems[0]).toContain("does not reach the schema a fresh database gets");
      expect(verdict.problems[0]).toContain(
        "add a migration rather than changing one that has run",
      );
      // Never a refusal with nothing to show for itself: the log carries the
      // line the two schemas part at.
      expect(verdict.note).toBeUndefined();
    }, 120_000);

    /**
     * The other shape that reaches the same place: the file is new, its place in
     * the order is not. A migration whose clock sits behind the high-water mark
     * is skipped forever on every deployed database and applied on every fresh
     * one — which is what rebasing a generated migration under a colleague's
     * produces.
     */
    test("a migration inserted behind one that has already been applied is refused", async () => {
      const repo = await committed(deployed(), {
        ...migratesFrom(JOURNALLED, "drizzle"),
        ...lineage(
          "drizzle",
          { tag: "0000_earlier", when: 500, sql: "CREATE TABLE `earlier` (`id` int);\n" },
          CREATES_THING,
        ),
      });

      const verdict = await ran(repo);

      expect(verdict.problems).toHaveLength(1);
      expect(verdict.problems[0]).toContain("does not reach the schema a fresh database gets");
    }, 120_000);

    /**
     * Moving the lineage strands every deployed database whose journal names it,
     * and no schema comparison can un-strand one — so it is refused where the
     * lineages are read, before anything is replayed.
     */
    test("a lineage the base ref carried and this tree does not is refused", async () => {
      const repo = await committed(deployed(), {
        ...migratesFrom(JOURNALLED, "elsewhere"),
        ...lineage("elsewhere", CREATES_THING),
      });

      const verdict = await ran(repo);

      expect(verdict.problems).toHaveLength(1);
      expect(verdict.problems[0]).toContain("carries the migration lineage drizzle");
      expect(verdict.problems[0]).toContain("strands every database that has one");
    }, 120_000);

    /**
     * The branch's own files are what the checkout holds afterwards, including
     * on the run that failed: the gate rolls the lineage back to the base ref to
     * replay it, and a checkout left holding another commit's migrations is a
     * developer's tree quietly rewritten.
     */
    test("the branch's own migrations are back in the checkout when the gate is done", async () => {
      const branch = {
        ...migratesFrom(JOURNALLED, "drizzle"),
        ...lineage("drizzle", CREATES_THING, ADDS_SLUG),
      };
      const repo = await committed(deployed(), branch);

      await ran(repo);

      const files = branch["drizzle/meta/_journal.json"];
      expect(files).toBeDefined();
      expect(await Bun.file(join(repo.root, "drizzle/meta/_journal.json")).text()).toBe(
        files ?? "",
      );
      expect(await Bun.file(join(repo.root, "drizzle/0001_slug.sql")).exists()).toBe(true);
    }, 120_000);

    /**
     * The database this gate builds is its own and is gone again, whichever way
     * the run went — a scratch database left behind is one the next run of the
     * same checkout meets instead of creating.
     */
    test("the database it replays into is dropped when it is done", async () => {
      const repo = await committed(deployed(), {
        ...deployed(),
        ...lineage("drizzle", CREATES_THING, ADDS_SLUG),
      });

      await ran(repo);

      const left = await query(
        await emptyDatabase(product),
        "select schema_name as name from information_schema.schemata where schema_name like 'upgrade\\_path\\_%'",
      );
      expect(left).toEqual([]);
    }, 120_000);
  });
}

/**
 * A first commit has no parent, which is a pass with a notice rather than a
 * refusal: there is no earlier schema for a deployed database to have been built
 * from. The shape that must NOT be passed this way is a checkout that cannot
 * answer — `repo.ts`'s shallow case, below.
 */
test("a commit with no parent has nothing to upgrade from, and says so", async () => {
  const product = PRODUCTS[0];
  if (product === undefined) throw new Error("this repo certifies no server product");
  const repo = await committed(deployed());
  const url = await emptyDatabase(product);
  await repo.migrate(url);

  const verdict = await upgradeGate({
    root: repo.root,
    url,
    image: product.image,
    event: { baseRef: "", before: "" },
    upgraded: join(repo.root, "upgraded.schema"),
  });

  expect(verdict.problems).toEqual([]);
  expect(verdict.note).toContain("no parent in the checkout");
}, 120_000);

/**
 * And the shape that looks identical from inside and means the opposite: a
 * shallow clone has a parent somewhere, just not here. Reading that as "nothing
 * to upgrade from" is a gate passing every run of every repo checked out the way
 * GitHub checks one out by default.
 */
test("a shallow checkout is refused rather than read as having no history", async () => {
  const product = PRODUCTS[0];
  if (product === undefined) throw new Error("this repo certifies no server product");
  const repo = await committed(deployed(), {
    ...deployed(),
    ...lineage("drizzle", CREATES_THING, ADDS_SLUG),
  });
  const shallow = await repo.shallow();
  const url = await emptyDatabase(product);

  const verdict = await upgradeGate({
    root: shallow,
    url,
    image: product.image,
    event: { baseRef: "", before: "" },
    upgraded: join(shallow, "upgraded.schema"),
  });

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain("the checkout is shallow");
  expect(verdict.problems[0]).toContain("fetch-depth: 0");
}, 120_000);
