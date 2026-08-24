/**
 * What a schema dump is, and whether two of them came out the same.
 *
 * The one derivation of that, for every gate here that compares two schemas —
 * the replay, and the upgrade path and integration lane behind it. Two answers
 * to one question would leave nobody able to say which was right the day they
 * disagreed.
 *
 * Pure, and in its own module for that reason: nothing below opens a socket or
 * spawns a process, so it is gradable without a server and reusable without
 * dragging one in. `database.ts` is the half that talks to MariaDB.
 *
 * The comparison is **not** a copy of dev-config's. Theirs is a multiset: the
 * lines one side holds that the other does not, with blank lines filtered out
 * of the count and a sentence about arrangement for whatever is left over. That
 * shape is wrong for a dump and provably so — see `compare`, and dev-config#70,
 * which is the same defect in their tree.
 */

/**
 * What the dump is asked for: no rows, and everything the catalogue holds that
 * a migration can build. Routines, events and triggers are not all in
 * `mariadb-dump`'s defaults, and a schema that left them out would call a
 * repo's stored procedures unchanged whatever had happened to them.
 *
 * `--skip-dump-date` rather than a rule below: the timestamp is the only thing
 * the tool writes that differs per invocation, and refusing to generate it is
 * one fewer statement about what the text may say.
 */
export const DUMP = ["--no-data", "--skip-dump-date", "--routines", "--events", "--triggers"];

/** A line of a dump whose content is not the schema, and what it is instead. */
interface Volatile {
  /** What the number or stamp actually records, for the page that has to justify dropping it. */
  readonly records: string;
  readonly of: RegExp;
  readonly to: string;
}

/**
 * The lines a MariaDB schema dump carries that move without the schema moving.
 *
 * One class, not a list of surprises: **how many values an object has handed
 * out, and when an object was last created**. Neither is a fact about what the
 * database can hold, both are rewritten by an ordinary migration doing ordinary
 * things, and a comparison that kept them refuses a repo that is fine.
 *
 * The membership was swept rather than guessed. A database carrying a table, a
 * sequence, a view, a procedure, a function, a trigger and an event, put twice
 * through the re-runnable idioms a migration is written in — `CREATE TABLE IF
 * NOT EXISTS` with an insert, `CREATE OR REPLACE VIEW`, `DROP … IF EXISTS`
 * before each `CREATE` — moved exactly these three lines and no others. Every
 * `DEFINER`, every `sql_mode` block, the sequence's own definition and the
 * whole compatibility preamble came out byte-identical.
 */
const VOLATILE: readonly Volatile[] = [
  {
    records: "a table's AUTO_INCREMENT counter — the id it would hand out next",
    // Anchored to the option list closing the CREATE TABLE. A column's own
    // AUTO_INCREMENT carries no `=`, and a default value that spelled one is
    // inside the parentheses rather than after them.
    of: /^(\).*?) AUTO_INCREMENT=\d+/u,
    to: "$1",
  },
  {
    records: "a sequence's position — the value it would hand out next",
    // `DO SETVAL(`s`, 1, 0);` becomes `DO SETVAL(`s`, 1001, 0);` the moment
    // anything consumes a value, and a sequence's default cache is 1000, so one
    // NEXTVAL moves it by a thousand. The sequence's own shape — start, min,
    // max, increment, cache, cycle — is on the CREATE line above and is left
    // alone.
    of: /^(DO SETVAL\(.*), -?\d+, \d+\);$/u,
    to: "$1, <next>, <cycles>);",
  },
  {
    records: "an event's start stamp — when the event was created",
    // An event with no explicit STARTS is stamped with its creation time, and
    // the idiomatic re-runnable migration is `DROP EVENT IF EXISTS` followed by
    // `CREATE EVENT` — which re-creates it, and re-stamps it, on every replay.
    // An author who wrote an absolute STARTS gets the same value from both
    // replays of one lineage, so nothing true is lost here; a gate comparing
    // two DIFFERENT lineages would have to think about it again.
    of: /^(.*\bEVENT\b.*\bSTARTS ')[^']*'/u,
    to: "$1<created>'",
  },
];

/** What this drops and why, for the page that has to name each one. */
export const EXCLUSIONS: readonly string[] = VOLATILE.map(({ records }) => records);

/**
 * A schema as a diagnostic about it has to name it, cut into the lines it is
 * compared in, with the lines above rewritten to what they mean.
 *
 * Lines, and in the order the dump wrote them. `mariadb-dump` renders the
 * catalogue in a fixed order, so two dumps holding the same statements in a
 * different arrangement really are two different databases; nothing here is
 * sorted. Both sides of any comparison come from one tool through one split, so
 * an index is a line number in both files and a difference can be addressed by
 * one.
 */
export function schemaFrom(of: string, dumped: string): Dump {
  const units = dumped.split("\n").map((line) => {
    let read = line;
    for (const { of: pattern, to } of VOLATILE) read = read.replace(pattern, to);
    return read;
  });
  return { of, units };
}

export interface Dump {
  readonly of: string;
  readonly units: readonly string[];
}

/** How two schemas differ. There is no such thing as an empty one. */
export interface Difference {
  /** What the log gets: where the two part, and what each holds from there. */
  readonly lines: readonly string[];
  /** What the annotation gets: the shortest true sentence about it. */
  readonly headline: string;
}

/**
 * How much of each side the log carries past the point they part.
 *
 * A bound rather than the whole tail, because one inserted line makes every
 * line after it differ — so an unbounded tail prints most of the schema on the
 * commonest failure there is, and a log that does that on every red run is one
 * people learn to scroll past. What a replay gate reports is a statement or two,
 * which is a few lines; both dumps leave the run whole in the evidence artifact,
 * so the log's job is to point at the divergence rather than to reproduce the
 * file.
 */
const TAIL = 20;

/** One side's line at the point they part, or the fact that it has none. */
function shows({ units }: Dump, at: number): string {
  const line = units[at];
  return line === undefined ? "nothing, it ends there" : `\`${line}\``;
}

/** One side's own account of where it parted and what it holds from there. */
function tailOf(dump: Dump, at: number): string[] {
  const rest = dump.units.slice(at);
  if (rest.length === 0) {
    return [`${dump.of} ends at line ${at}, and has no line ${at + 1}`];
  }
  const cut = rest.length - TAIL;
  const more = cut > 0 ? [`  … and ${cut} more line${cut === 1 ? "" : "s"}`] : [];
  return [
    `${dump.of}, from line ${at + 1}:`,
    ...rest.slice(0, TAIL).map((line) => `  ${line}`),
    ...more,
  ];
}

/**
 * Where two schemas part, or `undefined` if they never do.
 *
 * A walk in step rather than a set difference, and the difference between the
 * two is what can be said on a red run. Both sides came from one tool and one
 * split, so index `n` is line `n + 1` of both files: the first index at which
 * they disagree is a fact about the pair, and every answer below is built from
 * it.
 *
 * No branch can produce a `Difference` with nothing in `lines` — each side
 * contributes at least the sentence saying where it parted — so this half of "a
 * refusal always has something to show for itself" is structural. The other
 * half is not this module's: what reaches the log is `annotations.ts`'s to
 * write, and a dump line the runner would read as a workflow command is why it
 * relays rather than prints.
 *
 * A multiset of lines cannot do this. It has to decide what counts as content
 * before it can subtract, and a dump is mostly blank lines and repeated `SET`s
 * — so either they count, and every difference drowns in them, or they do not,
 * and two schemas differing **only** in blank lines subtract to nothing and are
 * reported as holding the same lines in a different order. Both halves of that
 * sentence are then false, and the log under it is empty of the one line that
 * actually differs.
 */
export function compare(left: Dump, right: Dump): Difference | undefined {
  const length = Math.max(left.units.length, right.units.length);
  let at = 0;
  while (at < length && left.units[at] === right.units[at]) at += 1;
  if (at === length) return undefined;

  return {
    headline: `${left.of} and ${right.of} first differ at line ${at + 1}: ${shows(left, at)} against ${shows(right, at)}`,
    lines: [...tailOf(left, at), ...tailOf(right, at)],
  };
}
