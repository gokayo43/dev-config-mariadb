import { expect, test } from "bun:test";

import { compare, type Dump } from "../.github/actions/db-replay/schema.ts";

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
