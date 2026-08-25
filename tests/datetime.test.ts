import { describe, expect, test } from "bun:test";

import { allowlistFrom, REASON } from "../.github/actions/_lib/allowlist.ts";
import { datetimeGate } from "../.github/actions/db-datetime/datetime.ts";

import { PRODUCTS, emptyDatabase, query } from "./servers.ts";

/**
 * A real server per case, because the thing this gate reads is a real server's
 * catalogue. What `information_schema.columns` answers for a column is the
 * whole of the gate's input — the precision `datetime(6)` reports, the type a
 * view gives a cast, what a generated column looks like — and a fixture of rows
 * would be this suite asserting what its author already believed. `servers.ts`
 * is the server; the schema in each case is written straight onto it, since
 * this gate grades a database rather than a tree.
 *
 * Every case runs against both products, and one of them is the reason this
 * gate needed anything doing at all: MySQL 8 answers a catalogue read with the
 * labels in upper case, so a gate that read the fields as MariaDB spells them
 * finds none of them and dies on the first row instead of grading a column.
 * Read as one suite run twice — the assertions are the same because the
 * behaviour is.
 */

/** The allowlist as a caller writes it: entries one per line, each with its reason. */
function allowing(...entries: readonly string[]): ReturnType<typeof allowlistFrom> {
  return allowlistFrom(entries.join("\n"), "datetime-allowlist");
}

for (const product of PRODUCTS) {
  describe(product.name, () => {
    /** A database holding exactly `schema`, and its URL. */
    async function built(...schema: readonly string[]): Promise<string> {
      const url = await emptyDatabase(product);
      for (const statement of schema) await query(url, statement);
      return url;
    }

    const REASONED = `${REASON}the shop's own clock, 09:00 wherever it is`;

    test("a schema whose instants are all TIMESTAMP passes, and the note says so", async () => {
      const url = await built(
        "create table `event` (`id` int primary key, `at` timestamp null, `at6` timestamp(6) null)",
      );

      const verdict = await datetimeGate(url, allowing());

      expect(verdict.problems).toEqual([]);
      expect(verdict.note).toContain("holds no DATETIME column");
    }, 60_000);

    /**
     * The gate's whole reason to exist, and the most plausible wrong implementation
     * is the one this case kills twice over: a gate keyed on `column_type` rather
     * than `data_type` grades `datetime` and `datetime(6)` as two types and lets
     * the second through, and one keyed on the name of the column rather than its
     * type never sees either.
     */
    test("an unallowlisted DATETIME column fails the run, naming it and what to store instead", async () => {
      const url = await built(
        "create table `event` (`id` int primary key, `at` datetime, `at6` datetime(6), `fine` timestamp null)",
      );

      const verdict = await datetimeGate(url, allowing());

      expect(verdict.problems).toEqual([
        expect.stringContaining("event.at is a DATETIME"),
        expect.stringContaining("event.at6 is a DATETIME"),
      ]);
      expect(verdict.problems[0]).toContain("Store the instant as TIMESTAMP");
      expect(verdict.problems[0]).toContain("datetime-allowlist");
      // Never a refusal that also claims a pass.
      expect(verdict.note).toBeUndefined();
    }, 60_000);

    test("a DATETIME column with a reasoned entry passes, and the note counts it", async () => {
      const url = await built("create table `shop` (`id` int primary key, `opens_at` datetime)");

      const verdict = await datetimeGate(url, allowing(`shop.opens_at${REASONED}`));

      expect(verdict.problems).toEqual([]);
      expect(verdict.note).toContain("1 DATETIME column is allowlisted with a reason");
    }, 60_000);

    /**
     * The price a lint directive pays. The entry still exempts its column — the
     * author is going back to that line anyway, and reporting the column as well
     * would be two diagnostics for one mistake — so the count here is one, and the
     * one is about the reason.
     */
    test("an entry with no reason fails the run and still exempts its column", async () => {
      const url = await built("create table `shop` (`id` int primary key, `opens_at` datetime)");

      const verdict = await datetimeGate(url, allowing("shop.opens_at"));

      expect(verdict.problems).toHaveLength(1);
      expect(verdict.problems[0]).toContain("waives shop.opens_at without saying why");
      expect(verdict.problems[0]).toContain(`shop.opens_at${REASON}<reason>`);
    }, 60_000);

    /**
     * The other half of that rule, and the only case that reaches it: an entry with
     * no reason whose subject is not a live DATETIME column either. The most
     * plausible wrong implementation is a dead-entry check that asks only whether
     * the subject is still graded — and then this one entry earns two diagnostics,
     * sending its author to write a reason AND to hunt for a column, over one
     * mistake that is entirely the first.
     */
    test("an entry with no reason is asked nothing about the column it names", async () => {
      const url = await built(
        "create table `shop` (`id` int primary key, `opens_at` timestamp null)",
      );

      const verdict = await datetimeGate(url, allowing("shop.gone"));

      expect(verdict.problems).toHaveLength(1);
      expect(verdict.problems[0]).toContain("waives shop.gone without saying why");
      expect(verdict.problems[0]).not.toContain("has no column called");
    }, 60_000);

    /**
     * The first way a waiver dies, and the diagnostic that has to say which: the
     * column is there and is not graded, so the entry goes. A gate that graded only
     * the wall-clock columns could not tell this from the case below, and would
     * send an author hunting for a column that is in front of them.
     */
    test("an entry for a column that is not a DATETIME is refused, naming that it is there", async () => {
      const url = await built(
        "create table `shop` (`id` int primary key, `opens_at` timestamp null)",
      );

      const verdict = await datetimeGate(url, allowing(`shop.opens_at${REASONED}`));

      expect(verdict.problems).toHaveLength(1);
      expect(verdict.problems[0]).toContain("has as a column that is not a DATETIME");
      expect(verdict.problems[0]).toContain("the entry goes");
      expect(verdict.problems[0]).not.toContain("no column called");
    }, 60_000);

    /**
     * And it says only that. The catalogue holds one row for a column that was
     * converted out of DATETIME and one for a column that never was, and they are
     * the same row — so a diagnostic announcing "the conversion has been made" is
     * telling an author about history the gate cannot see. The most plausible wrong
     * implementation is exactly that sentence, and this is the column that makes it
     * a lie: an `int` primary key nobody ever stored an instant in.
     */
    test("the refusal above claims no history, because the catalogue records none", async () => {
      const url = await built(
        "create table `shop` (`id` int primary key, `opens_at` timestamp null)",
      );

      const verdict = await datetimeGate(url, allowing(`shop.id${REASONED}`));

      expect(verdict.problems).toHaveLength(1);
      expect(verdict.problems[0]).toContain("shop.id");
      expect(verdict.problems[0]).not.toContain("conversion");
    }, 60_000);

    /** The other way, and the other half of the same rule: nothing answers to the name at all. */
    test("an entry for a column the database does not have is refused, naming that death instead", async () => {
      const url = await built("create table `shop` (`id` int primary key, `opens_at` datetime)");

      const verdict = await datetimeGate(
        url,
        allowing(`shop.opens_at${REASONED}`, `shop.closes_at${REASONED}`),
      );

      expect(verdict.problems).toHaveLength(1);
      expect(verdict.problems[0]).toContain("has no column called");
      expect(verdict.problems[0]).toContain("fix the name to match the column it was written for");
    }, 60_000);

    /**
     * A DATE, a TIME and a YEAR are not instants recorded wrongly — they never
     * claimed to be instants — so grading them would ask every consumer to justify
     * every birthdate it stores. The most plausible wrong implementation is a gate
     * that grades every temporal type, and this is the case that kills it.
     */
    test("DATE, TIME and YEAR columns are not graded", async () => {
      const url = await built(
        "create table `person` (`id` int primary key, `born` date, `starts` time, `vintage` year)",
      );

      const verdict = await datetimeGate(url, allowing());

      expect(verdict.problems).toEqual([]);
      expect(verdict.note).toContain("holds no DATETIME column");
    }, 60_000);

    /**
     * The catalogue is the fact. A generated column is one an ORM's schema may
     * never mention, and its type is the server's answer rather than the author's.
     */
    test("a generated DATETIME column is graded like any other", async () => {
      const url = await built(
        "create table `event` (`id` int primary key, `at` timestamp null," +
          " `local` datetime generated always as (`at`) virtual)",
      );

      const verdict = await datetimeGate(url, allowing());

      expect(verdict.problems).toEqual([expect.stringContaining("event.local is a DATETIME")]);
    }, 60_000);

    /**
     * A view is where a zone gets thrown away without a migration ever saying so:
     * `cast(ts as datetime)` reports `datetime` to the catalogue while the column
     * under it stays a TIMESTAMP, and a consumer reading the view gets the
     * ambiguous digits. Selecting the TIMESTAMP straight through costs nothing —
     * the view column is still a `timestamp` — so grading views buys the cast and
     * charges nothing for the honest case.
     */
    test("a view that casts an instant to DATETIME is graded, and one that does not is not", async () => {
      const url = await built(
        "create table `event` (`id` int primary key, `at` timestamp null)",
        "create view `v_honest` as select `at` from `event`",
        "create view `v_cast` as select cast(`at` as datetime) as `at_local` from `event`",
      );

      const verdict = await datetimeGate(url, allowing());

      expect(verdict.problems).toEqual([expect.stringContaining("v_cast.at_local is a DATETIME")]);
    }, 60_000);

    /**
     * Entries are one per line rather than space-separated because an identifier
     * can hold a space, and MariaDB really will accept one — so a gate splitting on
     * whitespace would read this entry as three subjects nobody wrote and refuse a
     * column that is waived.
     */
    test("a table and column whose names hold spaces can be waived", async () => {
      const url = await built("create table `opening hours` (`opens at` datetime)");

      const verdict = await datetimeGate(url, allowing(`opening hours.opens at${REASONED}`));

      expect(verdict.problems).toEqual([]);
      expect(verdict.note).toContain("1 DATETIME column is allowlisted");
    }, 60_000);

    /**
     * Which is exactly why the subject is trimmed of what surrounds the separator
     * rather than taken raw. An entry is a line of a YAML block a person typed, and
     * a second space before the `--` is the most ordinary thing to type; the wrong
     * implementation compares `shop.opens_at ` against the catalogue, waives
     * nothing, and refuses the entry as naming a column whose name differs from a
     * real one by a character nobody can see.
     */
    test("an entry padded around its separator waives the column it names", async () => {
      const url = await built("create table `shop` (`id` int primary key, `opens_at` datetime)");

      const verdict = await datetimeGate(url, allowing(`shop.opens_at ${REASONED}`));

      expect(verdict.problems).toEqual([]);
      expect(verdict.note).toContain("1 DATETIME column is allowlisted");
    }, 60_000);

    /**
     * Only the graded database. A MySQL-family connection can see every database on
     * the server — and the server's own `mysql`, `sys` and `information_schema`
     * carry DATETIME columns of their own — so a gate that forgot the filter would
     * open with refusals for columns no migration wrote and no consumer can
     * convert.
     */
    test("a DATETIME column in another database on the same server is not graded", async () => {
      const neighbour = await built("create table `event` (`at` datetime)");
      const url = await built("create table `fine` (`at` timestamp null)");

      const verdict = await datetimeGate(url, allowing());

      expect(verdict.problems).toEqual([]);
      // The neighbour really is there to have been read: a green verdict over an
      // empty server would prove nothing about the filter.
      expect(await query(neighbour, "select 1 as here")).toHaveLength(1);
    }, 60_000);

    /**
     * The one answer that would otherwise pass while having read nothing. A caller
     * whose DATABASE_URL names the service image's default database while the
     * migrator built another gets a catalogue with no rows in it, and every check
     * above is vacuously satisfied.
     */
    test("a database with no schema in it is refused rather than certified", async () => {
      const url = await emptyDatabase(product);

      const verdict = await datetimeGate(url, allowing());

      expect(verdict.problems).toHaveLength(1);
      expect(verdict.problems[0]).toContain("holds no schema at all");
      expect(verdict.note).toBeUndefined();
    }, 60_000);

    /**
     * The false refusal that check must not cause: a lineage whose whole schema is
     * one stored routine has no columns and is not empty, and the replay gate
     * already passes exactly that repo.
     */
    test("a database whose schema is one routine has read nothing to grade, and passes", async () => {
      const url = await built("create procedure `p_thing`() select 1");

      const verdict = await datetimeGate(url, allowing());

      expect(verdict.problems).toEqual([]);
      expect(verdict.note).toContain("holds no DATETIME column");
    }, 60_000);

    /**
     * The journal is a table like any other here, and that is worth a case because
     * the gate beside this one does the opposite: `db-replay` subtracts `JOURNAL`
     * from what it compares, since a migrator's bookkeeping is not schema. Carrying
     * that subtraction across is the most plausible wrong implementation of this
     * gate — and it would wave through exactly the DATETIME a migrator writes its
     * own clock into, which is a column no consumer's migrations can convert and
     * every consumer would rather have named.
     */
    test("the migrator's own journal is graded like any other table", async () => {
      const url = await built(
        "create table `__drizzle_migrations` (`id` int primary key, `created_at` datetime)",
      );

      const verdict = await datetimeGate(url, allowing());

      expect(verdict.problems).toEqual([
        expect.stringContaining("__drizzle_migrations.created_at is a DATETIME"),
      ]);
    }, 60_000);

    /**
     * A column answers to its name in any case, because the server does: probed on
     * the pinned image, `select shop.OPENS_AT` reads `opens_at`. A gate comparing
     * the two as text charges one mistake twice — it refuses the column as
     * unwaived AND refuses the entry as naming nothing — and the second diagnostic
     * is false to any reader who can select the column by the name they wrote.
     */
    test("an entry naming a column in another case waives it, and earns no diagnostic", async () => {
      const url = await built("create table `shop` (`id` int primary key, `opens_at` datetime)");

      const verdict = await datetimeGate(url, allowing(`shop.OPENS_AT${REASONED}`));

      expect(verdict.problems).toEqual([]);
      expect(verdict.note).toContain("1 DATETIME column is allowlisted");
    }, 60_000);

    /**
     * And the fold stops at the last dot, because the server's rule does. A table
     * is case-SENSITIVE here (`lower_case_table_names = 0`, the pinned image's
     * default), so `Shop` and `shop` are two tables and can hold different types
     * under one column name. The most plausible wrong implementation of the case
     * above is a fold over the whole `table.column` key — which would read this
     * entry as waiving the DATETIME in `shop`, and pass a schema this gate exists
     * to refuse.
     */
    test("an entry for another table in another case waives nothing in this one", async () => {
      const url = await built(
        "create table `shop` (`id` int primary key, `opens_at` datetime)",
        "create table `Shop` (`id` int primary key, `opens_at` timestamp null)",
      );

      const verdict = await datetimeGate(url, allowing(`Shop.opens_at${REASONED}`));

      expect(verdict.problems).toEqual([
        expect.stringContaining("shop.opens_at is a DATETIME"),
        expect.stringContaining("waives Shop.opens_at"),
      ]);
    }, 60_000);
  });
}
