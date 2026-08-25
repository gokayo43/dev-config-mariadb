import type { Allowlist } from "../_lib/allowlist.ts";
import { deadEntries } from "../_lib/allowlist.ts";
import type { Verdict } from "../_lib/annotations.ts";
import type { Foreign } from "../_lib/foreign.ts";
import { databaseIn, objectsIn, rowsFrom, textIn } from "../db-replay/database.ts";

/**
 * The MySQL family's half of the ambiguous-instant class, and it is the
 * opposite way round from Postgres's.
 *
 * `TIMESTAMP` is the safe type here: the server converts a value to UTC on the
 * way in and back to the session's zone on the way out, so the instant survives
 * a zone change intact. `DATETIME` stores the digits someone typed and forgets
 * which clock produced them — the same row read from a server in another zone,
 * or on the other side of a DST boundary, is a different instant, and nothing
 * fails until it does.
 *
 * So this gate is dev-config's timestamptz gate with the types swapped, and it
 * is one gate rather than one per server product: both products this repo
 * serves store and convert these two types the same way, probed on both pins.
 */

/** A column, as `information_schema.columns` names it. */
interface Column {
  readonly table_name: string;
  readonly column_name: string;
  /** The type with no precision on it: `datetime` for both `datetime` and `datetime(6)`. */
  readonly data_type: string;
}

/**
 * The one type graded, and it is one rather than a set because the other
 * temporal types are not instants recorded wrongly:
 *
 * - `TIMESTAMP` is the fix, not the fault — probed on both pinned images, at
 *   MariaDB 11.4.12 and MySQL 8.0.46: a row written as `12:00` under
 *   `time_zone = '+00:00'` reads back as `17:00` under `+05:00`, while the
 *   `DATETIME` beside it reads `12:00` either way.
 * - `DATE`, `TIME` and `YEAR` never claimed to be instants. A birthdate is a
 *   date, and grading them would ask every consumer to justify every one of
 *   them.
 *
 * `data_type` rather than `column_type`, because the second carries the
 * fractional-second precision — `datetime(6)` — and a gate keyed on it would
 * grade `datetime` and `datetime(6)` as two different types.
 *
 * A constant rather than a lookup keyed by what the catalogue answered: with
 * one member there is nothing to look up, and a comparison cannot be reached
 * through `Object.prototype` the way a plain-object map can.
 */
const WALL_CLOCK = "datetime";

/**
 * Every column of the graded database, and only of the graded database.
 *
 * The filter is not tidiness. A Postgres connection can see one database, so
 * dev-config's gate grades every schema in it and subtracts the catalogue's
 * own; a MySQL-family connection sees every database on the server, and the
 * server's own `information_schema`, `mysql` and `sys` carry `DATETIME` columns
 * no consumer's migrations wrote and no consumer can convert —
 * docs/gates/db-datetime.md counts them.
 *
 * It is also what makes `table.column` an unambiguous key: MySQL and MariaDB
 * have no schemas within a database — the schema IS the database — so once the
 * database is fixed there is nothing above the table to qualify with.
 *
 * Every column arrives rather than only the `DATETIME` ones, because the
 * allowlist is graded against the same read: which type is wall-clock is a fact
 * about this gate, and pushing it into the `where` clause would leave the gate
 * unable to tell a waiver for a converted column from one for a column that is
 * gone.
 *
 * Each selected column is aliased to its own name rather than taken bare, which
 * `rowsFrom` in db-replay/database.ts is where the reason for is written: the
 * two server products label a catalogue read in different case, and an alias is
 * the one spelling both answer under.
 */
const COLUMN_QUERY =
  "select table_name as table_name, column_name as column_name, data_type as data_type" +
  " from information_schema.columns where table_schema = ? order by table_name, column_name";

/** The catalogue's answer, refused unless every row carries the three names above as text. */
function columnsFrom(rows: readonly Foreign[], database: string): Column[] {
  return rows.map((row, at) => {
    const where = `row ${at} of ${database}'s columns`;
    return {
      table_name: textIn(row, "table_name", where),
      column_name: textIn(row, "column_name", where),
      data_type: textIn(row, "data_type", where),
    };
  });
}

/** How an entry names a column, and how every diagnostic here spells one. */
function named({ table_name, column_name }: Column): string {
  return `${table_name}.${column_name}`;
}

/**
 * The same name as the server would match it, which is not the same rule on
 * either side of the dot. Probed on the pinned images, at the default
 * `lower_case_table_names = 0` both of them ship on Linux:
 *
 * - a column is case-insensitive — `select shop.OPENS_AT` reads `opens_at`, and
 *   a table holding both is refused with `ERROR 1060 Duplicate column name`, so
 *   folding one cannot collide two columns into a single key;
 * - a table is NOT — `select … from SHOP` against `shop` is `ERROR 1146`, and
 *   `Shop` and `shop` coexist as two tables with different columns.
 *
 * So the fold stops at the last dot. Folding the whole key would let an entry
 * for one table waive a DATETIME in another, which is the failure this is
 * careful about rather than a nicety; the reader who wonders what a dot inside
 * an identifier does here is answered in docs/gates/db-datetime.md, under what
 * this gate cannot catch.
 */
function matched(subject: string): string {
  const dot = subject.lastIndexOf(".");
  return `${subject.slice(0, dot + 1)}${subject.slice(dot + 1).toLowerCase()}`;
}

/** The one line a green run leaves behind, which has to say what was actually read. */
function passed(database: string, waived: number): string {
  if (waived === 0) {
    return `datetime: ${database} holds no DATETIME column, so every instant it stores carries its zone`;
  }
  const columns = waived === 1 ? "1 DATETIME column is" : `${waived} DATETIME columns are each`;
  return `datetime: ${database}'s ${columns} allowlisted with a reason, and every other instant it stores carries its zone`;
}

/**
 * The gate. The database is asked directly, through `information_schema.columns`
 * — an ORM's `datetime()` is a hint and the catalogue is the fact, and asking it
 * means nothing here has to parse a schema dump.
 *
 * Nothing below writes, and the read is one query over one connection: it
 * answered in full or it threw, and a verdict built from a half-read catalogue
 * is not a state this can reach. The one answer that would otherwise pass
 * vacuously — no rows at all — is refused rather than certified.
 */
export async function datetimeGate(url: string, allowlist: Allowlist): Promise<Verdict> {
  const database = databaseIn(url);
  const columns = columnsFrom(await rowsFrom(url, COLUMN_QUERY, [database]), database);

  // A database with no columns is either one nothing has migrated or one this
  // job was pointed at by mistake — a caller whose DATABASE_URL names the
  // image's default database while the migrator built another. Both pass every
  // check below without a column having been read, which is a green step
  // certifying nothing. Asked only when there are no columns, and asked of the
  // whole catalogue rather than of tables, because a schema that is one stored
  // routine has no columns and is not empty.
  if (columns.length === 0 && (await objectsIn(url)).length === 0) {
    return {
      problems: [
        `${database} holds no schema at all, so this gate read no column and would pass a database its migrations never reached. Point DATABASE_URL at the database they built.`,
      ],
    };
  }

  // The catalogue's own spelling is what every diagnostic quotes; `matched` is
  // only ever the key two spellings of one column meet under.
  const wallClock: string[] = [];
  const graded = new Set<string>();
  const ambiguous = new Set<string>();
  for (const column of columns) {
    const name = named(column);
    graded.add(matched(name));
    if (column.data_type === WALL_CLOCK) {
      wallClock.push(name);
      ambiguous.add(matched(name));
    }
  }

  const deliberate = new Set(allowlist.entries.map(matched));
  const refusals = wallClock
    .filter((column) => !deliberate.has(matched(column)))
    .map(
      (column) =>
        `${column} is a DATETIME — it keeps the digits someone typed and forgets which clock produced them, so one row means two different instants either side of a DST boundary or a server move. Store the instant as TIMESTAMP, or list it in datetime-allowlist if the wall-clock reading is the point.`,
    );

  // Each set holds the ENTRIES that answer to something rather than the columns
  // they answer to, so that a diagnostic quotes the line its author wrote and
  // not the catalogue's spelling of it — the two differ exactly when this fixes
  // something.
  const answering = (keys: ReadonlySet<string>): ReadonlySet<string> =>
    new Set(allowlist.entries.filter((entry) => keys.has(matched(entry))));

  const fossils = deadEntries(allowlist, answering(ambiguous), answering(graded), (column, here) =>
    here
      ? `datetime-allowlist waives ${column}, which ${database} has as a column that is not a DATETIME — this gate grades DATETIME and nothing else, so there is nothing here to waive and the entry goes`
      : `datetime-allowlist waives ${column}, which ${database} has no column called — drop the entry, or fix the name to match the column it was written for`,
  );

  const problems = [...allowlist.problems, ...refusals, ...fossils];
  if (problems.length > 0) return { problems };
  return { note: passed(database, wallClock.length), problems: [] };
}
