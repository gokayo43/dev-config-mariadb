/**
 * Two schemas, and whether they came out the same.
 *
 * The one derivation of that, for every gate here that compares two of them —
 * the replay, and the upgrade path and integration lane behind it. Two answers
 * to one question would leave nobody able to say which was right the day they
 * disagreed.
 *
 * Pure, and in its own module for that reason: nothing below opens a socket or
 * spawns a process, so it is gradable without a server and reusable without
 * dragging one in. `database.ts` is the half that talks to MariaDB.
 *
 * This module is **not** a copy of dev-config's comparison. Theirs is a
 * multiset: the lines one side holds that the other does not, with blank lines
 * filtered out of the count and a sentence about arrangement for whatever is
 * left over. That shape is wrong for a schema dump and provably so — see
 * `compare` below, and dev-config#70, which is the same defect in their tree.
 */

/**
 * A schema as a diagnostic about it has to name it, cut into the lines it is
 * compared in.
 *
 * Lines, and in the order the dump wrote them. `mariadb-dump` renders the
 * catalogue in a fixed order, so two dumps holding the same statements in a
 * different arrangement really are two different databases; nothing here is
 * sorted. Both sides of any comparison come from one tool through one split, so
 * an index is a line number in both files and a difference can be addressed by
 * one.
 */
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
  const more = rest.length > TAIL ? [`  … and ${rest.length - TAIL} more lines`] : [];
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
 * it. There is no branch that can produce a `Difference` with nothing in
 * `lines` — each side contributes at least the sentence saying where it parted
 * — so a refusal with nothing to show for itself is unrepresentable rather than
 * merely avoided, which is the one thing no gate here may produce.
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
