import { expect, test } from "bun:test";

import { compare, type Dump, EXCLUSIONS, schemaFrom } from "../.github/actions/db-replay/schema.ts";

/**
 * The one derivation of "these two came out the same", graded without a
 * database: what it is asked is a question about two lists of lines, and every
 * gate here that compares two schemas gets whatever this answers.
 *
 * The contract under test is that a `Difference` is never empty and never says
 * anything untrue about the pair. The wrong implementation it is written
 * against is the one this replaced, and the one dev-config still runs
 * (dev-config#70): subtract the two as multisets of lines, filter blank lines
 * out of the count so they do not drown every diagnostic, and say "the same
 * lines are arranged differently" about whatever is left. Two schemas differing
 * only in blank lines then subtract to nothing — and are reported with a
 * sentence whose every clause is false, above a log holding none of the lines
 * that differ.
 */

function dump(of: string, ...units: readonly string[]): Dump {
  return { of, units };
}

test("two schemas holding the same lines in the same order are the same", () => {
  const units = ["CREATE TABLE `thing` (", "  `id` int", ") ENGINE=InnoDB;"];
  expect(compare(dump("the first", ...units), dump("the second", ...units))).toBeUndefined();
});

test("two empty schemas are the same", () => {
  expect(compare(dump("the first"), dump("the second"))).toBeUndefined();
});

test("a line one schema has and the other does not is named, with the line it is on", () => {
  const difference = compare(
    dump("the first", "CREATE TABLE `thing` (", ") ENGINE=InnoDB;"),
    dump("the second", "CREATE TABLE `thing` (", "  `slug` varchar(80),", ") ENGINE=InnoDB;"),
  );

  expect(difference?.headline).toBe(
    "the first and the second first differ at line 2: `) ENGINE=InnoDB;` against `  `slug` varchar(80),`",
  );
  expect(difference?.lines).toEqual([
    "the first, from line 2:",
    "  ) ENGINE=InnoDB;",
    "the second, from line 2:",
    "    `slug` varchar(80),",
    "  ) ENGINE=InnoDB;",
  ]);
});

test("a changed line is named against the line that replaced it", () => {
  const difference = compare(
    dump("the first", "  `id` int", "  `name` varchar(80)"),
    dump("the second", "  `id` bigint", "  `name` varchar(80)"),
  );

  expect(difference?.headline).toBe(
    "the first and the second first differ at line 1: `  `id` int` against `  `id` bigint`",
  );
  expect(difference?.lines.join("\n")).toContain("  `id` int");
  expect(difference?.lines.join("\n")).toContain("  `id` bigint");
});

/**
 * The regression this module was rewritten for. One side carries a blank line
 * the other does not, and nothing else differs.
 *
 * The multiset this replaced dropped blank lines before subtracting, so the two
 * sides came out equal, and it answered "differ, but not in which lines they
 * hold — the same lines are in a different order" with that sentence as the
 * whole of its log. Neither clause was true: they hold different lines, and
 * nothing is in a different order. The line that actually differs was the one
 * thing the log did not contain.
 */
test("a blank line one schema has and the other does not is reported as the difference it is", () => {
  const difference = compare(
    dump("the first", "CREATE TABLE `a`;", "", "CREATE TABLE `b`;"),
    dump("the second", "CREATE TABLE `a`;", "CREATE TABLE `b`;"),
  );

  expect(difference?.headline).toBe(
    "the first and the second first differ at line 2: `` against `CREATE TABLE `b`;`",
  );
  expect(difference?.headline).not.toContain("different order");
  expect(difference?.lines).toEqual([
    "the first, from line 2:",
    "  ",
    "  CREATE TABLE `b`;",
    "the second, from line 2:",
    "  CREATE TABLE `b`;",
  ]);
});

test("a schema that simply ends early says so rather than quoting a line it does not have", () => {
  const difference = compare(
    dump("the first", "CREATE TABLE `a`;"),
    dump("the second", "CREATE TABLE `a`;", "CREATE TABLE `b`;"),
  );

  expect(difference?.headline).toBe(
    "the first and the second first differ at line 2: nothing, it ends there against `CREATE TABLE `b`;`",
  );
  expect(difference?.lines).toEqual([
    "the first ends at line 1, and has no line 2",
    "the second, from line 2:",
    "  CREATE TABLE `b`;",
  ]);
});

// Two schemas holding the same statements in a different arrangement are two
// different databases, since the dump's order is fixed. What matters here is
// that the answer names a line rather than reaching for a sentence about
// arrangement that cannot say which lines were involved.
test("a reordering is reported at the line where the order first parts", () => {
  const difference = compare(
    dump("the first", "CREATE TABLE `a`;", "CREATE TABLE `b`;"),
    dump("the second", "CREATE TABLE `b`;", "CREATE TABLE `a`;"),
  );

  expect(difference?.headline).toBe(
    "the first and the second first differ at line 1: `CREATE TABLE `a`;` against `CREATE TABLE `b`;`",
  );
});

/**
 * The bound on the log, and the reason there is one: a single inserted line
 * makes every line after it differ, so an unbounded tail prints most of the
 * schema on the commonest failure there is. What is cut is counted rather than
 * dropped silently, and both dumps leave the run whole in the evidence
 * artifact.
 */
test("a long tail is cut to a readable length and says how much it cut", () => {
  const long = Array.from({ length: 30 }, (_, at) => `line ${at}`);
  const difference = compare(dump("the first", "head", ...long), dump("the second", "head"));

  expect(difference?.lines).toContain("  … and 10 more lines");
  expect(difference?.lines).toHaveLength(1 + 20 + 1 + 1);
  expect(difference?.lines.at(-1)).toBe("the second ends at line 1, and has no line 2");
});

// The whole of the contract, asked of every shape above at once: there is no
// pair of schemas for which this reports a difference and prints nothing.
test("no difference is ever empty", () => {
  const pairs: (readonly [Dump, Dump])[] = [
    [dump("a", "x"), dump("b")],
    [dump("a"), dump("b", "x")],
    [dump("a", ""), dump("b")],
    [dump("a", "x", ""), dump("b", "x")],
    [dump("a", "x", "y"), dump("b", "y", "x")],
    [dump("a", "x"), dump("b", "X")],
  ];
  for (const [left, right] of pairs) {
    const difference = compare(left, right);
    expect(difference?.lines.length ?? 0).toBeGreaterThan(0);
    expect(difference?.headline ?? "").not.toBe("");
  }
});

/**
 * The other half of this module: what a dump line means before two of them are
 * compared. Each case is one member of the class — a number recording how many
 * values an object has handed out, or a stamp recording when one was created —
 * and each is a line the shipped gate has been driven to a red verdict on
 * before the rule for it existed.
 */

test("a table's AUTO_INCREMENT counter is not part of its schema", () => {
  const before = schemaFrom("before", ") ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4;");
  const after = schemaFrom("after", ") ENGINE=InnoDB AUTO_INCREMENT=91 DEFAULT CHARSET=utf8mb4;");

  expect(compare(before, after)).toBeUndefined();
  expect(before.units).toEqual([") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;"]);
});

test("a column's own AUTO_INCREMENT keyword survives, since it carries no counter", () => {
  const kept = "  `id` int(11) NOT NULL AUTO_INCREMENT,";
  expect(schemaFrom("a", kept).units).toEqual([kept]);
});

test("a sequence's position is not part of its schema", () => {
  const before = schemaFrom("before", "DO SETVAL(`counter`, 2, 0);");
  const after = schemaFrom("after", "DO SETVAL(`counter`, 1001, 0);");

  expect(compare(before, after)).toBeUndefined();
  expect(before.units).toEqual(["DO SETVAL(`counter`, <next>, <cycles>);"]);
});

test("a sequence's own shape is still compared", () => {
  const before = schemaFrom(
    "before",
    "CREATE SEQUENCE `s` start with 1 increment by 1 cache 1000;",
  );
  const after = schemaFrom("after", "CREATE SEQUENCE `s` start with 1 increment by 2 cache 1000;");

  expect(compare(before, after)?.headline).toContain("first differ at line 1");
});

test("an event's start stamp is not part of its schema", () => {
  const event = (at: string): string =>
    `/*!50106 CREATE*/ /*!50117 DEFINER=\`root\`@\`%\`*/ /*!50106 EVENT \`sweep\` ON SCHEDULE EVERY 1 DAY STARTS '${at}' ON COMPLETION NOT PRESERVE ENABLE DO SELECT 1 `;

  expect(
    compare(
      schemaFrom("before", event("2026-08-24 15:40:48")),
      schemaFrom("after", event("2026-08-24 15:40:50")),
    ),
  ).toBeUndefined();
});

test("what an event actually does is still compared", () => {
  const body = (does: string): string =>
    `/*!50106 CREATE*/ /*!50106 EVENT \`sweep\` ON SCHEDULE EVERY 1 DAY STARTS '2026-08-24 15:40:48' ENABLE DO ${does} `;

  expect(
    compare(schemaFrom("before", body("SELECT 1")), schemaFrom("after", body("DELETE FROM t"))),
  ).not.toBeUndefined();
});

// Every rule the module carries has to be justifiable on the page that lists
// them, so the list is what the page is written from rather than a second copy
// of it.
test("every exclusion says what it records instead of schema", () => {
  expect(EXCLUSIONS).toHaveLength(3);
  for (const records of EXCLUSIONS) expect(records).not.toBe("");
});

test("an ordinary schema line is left exactly as the dump wrote it", () => {
  const lines = [
    "CREATE TABLE `thing` (",
    "  `id` int(11) NOT NULL,",
    "  PRIMARY KEY (`id`)",
    "/*!40101 SET character_set_client = @saved_cs_client */;",
    "",
  ];
  expect(schemaFrom("a", lines.join("\n")).units).toEqual(lines);
});
