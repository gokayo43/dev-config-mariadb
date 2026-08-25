import { expect, test } from "bun:test";
import { join } from "node:path";

import { baseLineages } from "../.github/actions/db-upgrade/base-lineage.ts";
import { baseRevision } from "../.github/actions/db-upgrade/repo.ts";

import { lineage, migratesFrom } from "./lineage.ts";
import { committed, headOf } from "./repo.ts";
import { type Tree } from "./tree.ts";

/**
 * What the upgrade gate reads before it replays anything: which commit is the
 * base, and which lineages that commit carried.
 *
 * Driven directly rather than through `upgradeGate`, and that is the point of
 * the split: every case here is decided out of git alone, so asking them of the
 * whole gate would be paying for a server, a migrator and two dumps to be told
 * something the first two functions already knew. `upgrade.test.ts` is where
 * the gate's own verdict is graded, against both products.
 *
 * These are the refusals a consumer meets, so they are the ones worth having
 * cases for: each is a shape that would otherwise be replayed into a wrong
 * answer, or a schema comparison that passed by not having looked.
 */

const MIGRATION = { tag: "0000_thing", when: 1_000, sql: "CREATE TABLE `thing` (`id` int);\n" };

/** A project whose migrations live in `dir`. */
function project(dir: string): Tree {
  return { ...migratesFrom("tests/journalled-migrator.ts", dir), ...lineage(dir, MIGRATION) };
}

test("a lineage the base ref carried is read out of it, files and all", async () => {
  const repo = await committed(project("drizzle"), {
    ...project("drizzle"),
    ...lineage("drizzle", MIGRATION, { tag: "0001_more", when: 2_000, sql: "SELECT 1;\n" }),
  });

  const { lineages, problems } = await baseLineages(repo.root, await headOf(repo.root, "HEAD^"));

  expect(problems).toEqual([]);
  expect(lineages.map(({ dir }) => dir)).toEqual(["drizzle"]);
  // The base ref's files, not this branch's: the second migration is on the
  // branch and must not be in what gets replayed.
  expect(lineages[0]?.files.map(({ path }) => path).toSorted()).toEqual([
    "0000_thing.sql",
    "meta/_journal.json",
  ]);
});

/**
 * A lineage is replayed by replacing its directory, which is only a local act
 * when that directory holds one lineage and nothing else. At the project root
 * the directory is the project.
 */
test("a lineage at the project root is refused rather than replayed", async () => {
  const root = {
    "package.json": '{"name":"fixture","scripts":{"db:migrate":"true"}}\n',
    ...lineage(".", MIGRATION),
  };
  const repo = await committed(root, { ...root, "extra.sql": "SELECT 1;\n" });

  const { problems } = await baseLineages(repo.root, await headOf(repo.root, "HEAD^"));

  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("the project root is itself a migration lineage");
});

/** And one lineage inside another is a delete taking a lineage nobody asked it to touch. */
test("a lineage inside another is refused rather than replayed", async () => {
  const nested = { ...project("drizzle"), ...lineage("drizzle/inner", MIGRATION) };
  const repo = await committed(nested, { ...nested, "extra.sql": "SELECT 1;\n" });

  const { problems } = await baseLineages(repo.root, await headOf(repo.root, "HEAD^"));

  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("is inside the lineage");
});

/**
 * The project directory itself moving is the same fault as a lineage moving,
 * one level up — every database built from the lineage it carried is stranded.
 * git is asked which of the two it is rather than guessed at: a project this
 * branch ADDS has no base lineage and passes, and one that was somewhere else
 * carries the lineage the gate exists to protect.
 */
test("a project that moved, taking its lineage with it, is refused", async () => {
  const before: Tree = {
    "old/package.json": '{"name":"fixture","scripts":{"db:migrate":"true"}}\n',
    ...lineage("old/drizzle", MIGRATION),
  };
  const after: Tree = {
    "app/package.json": before["old/package.json"] ?? "",
    ...lineage("app/drizzle", MIGRATION),
  };
  const repo = await committed(before, after);

  const { problems } = await baseLineages(join(repo.root, "app"), await headOf(repo.root, "HEAD^"));

  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("this project's migration lineage moved with it");
  expect(problems[0]).toContain("leave the lineage where it was");
});

/** A project this branch adds has no base lineage, and no database was ever built from one. */
test("a project this branch adds has nothing to upgrade from, and is not refused", async () => {
  const repo = await committed(
    { "README.md": "before\n" },
    { "README.md": "before\n", ...project("app/drizzle") },
  );

  const { lineages, problems } = await baseLineages(
    join(repo.root, "app"),
    await headOf(repo.root, "HEAD^"),
  );

  expect(problems).toEqual([]);
  expect(lineages).toEqual([]);
});

/**
 * The base-ref table, at the two rows a fixture can state: a checkout that
 * cannot resolve the base branch it was told about, and a push whose `before`
 * is a commit this checkout carries.
 *
 * The rows are one function rather than each gate's own, so the failure to
 * catch is a gate reading "cannot say" as "nothing to compare against" — which
 * is why the first of these is a refusal and not an empty answer.
 */
test("a base branch that is not in the checkout is refused, not read as no history", async () => {
  const repo = await committed(project("drizzle"), {
    ...project("drizzle"),
    "x.sql": "SELECT 1;\n",
  });

  const base = await baseRevision(repo.root, { baseRef: "not-a-branch", before: "" }, "why");

  expect("refused" in base && base.refused).toContain("is not in this checkout");
  expect("refused" in base && base.refused).toContain("fetch-depth: 0");
});

test("a push names the tip the branch had before it, and that is the base", async () => {
  const repo = await committed(project("drizzle"), {
    ...project("drizzle"),
    "x.sql": "SELECT 1;\n",
  });
  const parent = await headOf(repo.root, "HEAD^");

  const base = await baseRevision(repo.root, { baseRef: "", before: parent }, "why");

  expect("rev" in base && base.rev).toBe(parent);
});
