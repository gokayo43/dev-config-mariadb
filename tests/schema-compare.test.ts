import { expect, test } from "bun:test";

import { compare, type Dump } from "../.github/actions/db-replay/database.ts";

/**
 * The one derivation of "these two came out the same", graded without a
 * database: what it is asked is a question about two lists of lines, and every
 * gate here that compares two schemas gets whatever this answers.
 *
 * The property under test is the contract `compare` exists to keep — there is
 * no such thing as an empty difference — and the wrong implementation it is
 * written against is the obvious one: compare the joined text, and report the
 * lines one holds that the other does not. That is right until the two hold the
 * same lines in a different order, where it produces a refusal with nothing
 * printed under it, on the run where the reader most needs something.
 */

function dump(of: string, ...units: readonly string[]): Dump {
  return { of, units };
}

test("two schemas holding the same lines in the same order are the same", () => {
  const units = ["CREATE TABLE `thing` (", "  `id` int", ") ENGINE=InnoDB;"];
  expect(compare(dump("the first", ...units), dump("the second", ...units))).toBeUndefined();
});

test("a line one schema has and the other does not is named, addressed to the one that has it", () => {
  const difference = compare(
    dump("the first", "CREATE TABLE `thing` (", ") ENGINE=InnoDB;"),
    dump("the second", "CREATE TABLE `thing` (", "  `slug` varchar(80),", ") ENGINE=InnoDB;"),
  );

  expect(difference?.lines).toEqual(["only in the second:   `slug` varchar(80),"]);
  expect(difference?.headline).toBe("the second alone has 1 line, first `  `slug` varchar(80),`");
});

test("a line each schema has and the other does not is named on both sides", () => {
  const difference = compare(
    dump("the first", "  `id` int", "  `name` varchar(80)"),
    dump("the second", "  `id` bigint", "  `name` varchar(80)"),
  );

  expect(difference?.lines).toEqual([
    "only in the first:   `id` int",
    "only in the second:   `id` bigint",
  ]);
  expect(difference?.headline).toContain("the first alone has 1 line");
  expect(difference?.headline).toContain("the second alone has 1 line");
});

// A dump is compared in the order it was written, so this really is a
// difference. The point of the case is that it is a difference nothing can name
// line by line — and a refusal with an empty log is the one thing no gate here
// may produce.
test("two schemas holding the same lines in a different order still say what differs", () => {
  const difference = compare(
    dump("the first", "CREATE TABLE `a`;", "CREATE TABLE `b`;"),
    dump("the second", "CREATE TABLE `b`;", "CREATE TABLE `a`;"),
  );

  const headline = difference?.headline ?? "";
  expect(headline).toContain("the same lines are in a different order");
  // The whole of the contract: a difference nothing can list is still printed.
  expect(difference?.lines).toEqual([headline]);
});

// Blank lines are what a dump has most of, and counting them as content would
// make every difference above unreadable. A schema that has genuinely lost a
// blank line still differs, and the arrangement sentence is what says so.
test("a blank line more on one side is a difference nothing can list", () => {
  const difference = compare(
    dump("the first", "CREATE TABLE `a`;", ""),
    dump("the second", "CREATE TABLE `a`;"),
  );

  expect(difference?.headline).toContain("the same lines are in a different order");
});

test("a line one schema has twice and the other once is named once", () => {
  const difference = compare(
    dump("the first", "ADD CHECK;", "ADD CHECK;"),
    dump("the second", "ADD CHECK;"),
  );

  expect(difference?.lines).toEqual(["only in the first: ADD CHECK;"]);
});
