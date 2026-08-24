import type { Verdict } from "../_lib/annotations.ts";
import { mapAt, textAt } from "../_lib/foreign.ts";
import {
  compare,
  databaseIn,
  type Dump,
  dumpOf,
  migrate,
  objectsIn,
  schemaIn,
} from "./database.ts";

/**
 * What a repo's migration history is asked to prove here, and it is one
 * question asked twice.
 *
 * **From empty.** An empty database is the state no developer machine is ever
 * in and the state every new box and every restore drill starts from. A
 * migration written against a database that already had the table it alters
 * succeeds where its author ran it and aborts the first time the history runs
 * onto nothing — a database that cannot be rebuilt, found at the worst possible
 * moment. Replaying from empty on every push is what turns that into a red
 * build.
 *
 * **And again.** The verdict is not the second run's exit code. An exit code
 * says only that nothing errored, and a runner with no journal, or one syncing
 * a schema rather than applying a history, exits 0 having changed the database
 * — a second unnamed `ADD CHECK`, a second index under a generated name. So the
 * schema is read back either side and has to come out identical: with a
 * journalled migrator that proves the journal is honest, and with anything that
 * re-executes SQL it proves the SQL is re-runnable.
 *
 * Both are decided by `compare` in database.ts, over the same normalised dump.
 */

/** What a repo declares its migrator as, and the only command this gate runs. */
const SCRIPT = "db:migrate";

/**
 * `AUTO_INCREMENT=<n>` in a table's option list: the value the counter would
 * hand out next.
 *
 * The one thing a MariaDB schema dump carries that moves without the schema
 * moving. It is a fact about how many rows have been inserted — a migration
 * that seeds a row, a migrator that writes its own journal — so a database
 * whose schema is untouched still renders differently once anything has
 * written to it, and comparing dumps without taking it out would refuse a repo
 * that is fine.
 *
 * Anchored to the option list, which is the line that closes the `CREATE
 * TABLE`. A column's own `AUTO_INCREMENT` carries no `=`, and a default value
 * that happened to spell one is inside a `CREATE` rather than after its
 * closing paren.
 *
 * It is the only exclusion. Two dumps of one database taken a second apart are
 * otherwise byte-identical once `--skip-dump-date` has taken the timestamp out
 * — the header, the compatibility `SET`s, the `DEFINER` on every view and
 * trigger and the `STARTS` clause on an event are all stable — so nothing else
 * here is filtered, and a line that moves is a line worth failing over.
 */
const COUNTER = /^(\).*?) AUTO_INCREMENT=\d+/u;

/**
 * What the dump is asked for: no rows, and everything the catalogue holds that
 * a migration can build. Routines and events are not in `mariadb-dump`'s
 * defaults, and a schema that left them out would call a repo's stored
 * procedures unchanged whatever had happened to them.
 *
 * `--skip-dump-date` rather than a filter over the output: the timestamp is the
 * only thing the tool writes that differs per invocation, and refusing to
 * generate it is one fewer rule about what the text may say.
 */
const DUMP = ["--no-data", "--skip-dump-date", "--routines", "--events", "--triggers"];

/** The schema as the server's client renders it, minus the one thing that moves without it. */
async function schemaOf(url: string, image: string, of: string): Promise<Dump> {
  const dumped = await dumpOf(url, image, DUMP);
  return { of, units: dumped.split("\n").map((line) => line.replace(COUNTER, "$1")) };
}

/**
 * A dump as the run leaves it behind. Written as it is taken rather than at the
 * end, so that a run which failed on the way to the second one still ships the
 * first: the dump a comparison never got to make is exactly the evidence
 * somebody wants, and reproducing it by re-running with more printing is the
 * shape of debugging every diagnostic here exists to avoid.
 */
async function keep(dump: Dump, at: string): Promise<Dump> {
  await Bun.write(at, `${dump.units.join("\n")}\n`);
  return dump;
}

/** Where the gate replays, what it replays with, and where the evidence goes. */
export interface Replay {
  /** The project the calling job declared: where `bun run db:migrate` runs. */
  readonly root: string;
  /** The database that job declared. Empty when the gate starts, and migrated when it ends. */
  readonly url: string;
  /** The image the job runs the server from, which is where the dump's client comes from. */
  readonly image: string;
  /** Where the schema built from empty is left. */
  readonly fromEmpty: string;
  /** Where the schema after the second replay is left. */
  readonly replayed: string;
}

/** Whether the project declares the one script this gate runs. */
async function declaresMigrator(root: string): Promise<boolean> {
  const manifest = Bun.file(`${root}/package.json`);
  if (!(await manifest.exists())) return false;
  return textAt(mapAt(await manifest.json(), "scripts"), SCRIPT) !== undefined;
}

/** The first few of a list, for a diagnostic that has to show what it found without printing a catalogue. */
function some(names: readonly string[]): string {
  const shown = names.slice(0, 3);
  return `${shown.join(", ")}${names.length > shown.length ? ", …" : ""}`;
}

const REPLAYED =
  "replay: the migrations rebuild the schema from empty, and replaying them leaves it identical";

export async function replayGate({
  root,
  url,
  image,
  fromEmpty,
  replayed,
}: Replay): Promise<Verdict> {
  const database = databaseIn(url);

  // Answerable from the filesystem alone, and ahead of everything below because
  // everything below costs a migrator run against a real server. A repo with no
  // migrator is not a repo whose history rebuilds: it is a call that asked for
  // this gate and gave it nothing to run, and passing would be certifying that.
  if (!(await declaresMigrator(root))) {
    return {
      problems: [
        `${root}/package.json declares no ${SCRIPT} script, and this gate has nothing to replay — a migration history it was never shown is one it cannot say anything about. Declare the script, or drop database: true from the call.`,
      ],
    };
  }

  // The claim is that these migrations built this schema. Against a database
  // something else has already been in, that claim is about the two of them
  // together and nobody can tell which built what — so the state the whole gate
  // rests on is established rather than assumed.
  const before = await objectsIn(url);
  if (before.length > 0) {
    return {
      problems: [
        `${database} already holds ${before.length} object${before.length === 1 ? "" : "s"} (${some(before)}) before a migration has run. This gate replays a history onto an empty database and reports what that history built; give the job a database nothing else writes to.`,
      ],
    };
  }

  await migrate(
    root,
    url,
    `bun run ${SCRIPT} failed building ${database} from empty — the migrator's own output above names the statement. A statement that needs a table an earlier migration has already dropped applies where it was written and aborts here, which is the whole reason this replay exists.`,
  );

  // An exit code of 0 over a lineage nobody pointed the migrator at looks
  // exactly like a clean rebuild. The journal is left out of the count on
  // purpose: a migrator that recorded having applied nothing leaves that table
  // and nothing else, which is the shape this refuses.
  const built = schemaIn(await objectsIn(url));
  if (built.length === 0) {
    return {
      problems: [
        `bun run ${SCRIPT} succeeded and left ${database} with no schema in it. This gate's verdict is what the migrations built, so an empty answer certifies nothing at all; point the migrator at the lineage, or drop database: true from the call.`,
      ],
    };
  }

  const fresh = await keep(await schemaOf(url, image, "the schema built from empty"), fromEmpty);

  await migrate(
    root,
    url,
    `bun run ${SCRIPT} failed on its second run over ${database}, having just succeeded on its first — the migrator's own output above names the statement. It met a database that already carries its effects, so either the runner is re-executing what it has applied or that statement cannot be applied twice.`,
  );
  const again = await keep(
    await schemaOf(url, image, "the schema after a second replay"),
    replayed,
  );

  const changed = compare(fresh, again);
  if (changed === undefined) return { note: REPLAYED, problems: [] };
  return {
    log: changed.lines.join("\n"),
    problems: [
      `replaying the migrations a second time changed ${database}'s schema — ${changed.headline}. What a database holds must not depend on how many times it was migrated: have the runner skip what it has already applied, or make the statements that ran again re-runnable.`,
    ],
  };
}
