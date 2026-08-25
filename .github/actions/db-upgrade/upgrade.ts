import { relay, type Verdict } from "../_lib/annotations.ts";
import { isForeign, isList } from "../_lib/foreign.ts";
import {
  connection,
  databaseIn,
  dumpClientIn,
  dumpOf,
  JOURNAL,
  migrate,
  rowsFrom,
} from "../db-replay/database.ts";
import { compare, type Dump, DUMP, schemaFrom } from "../db-replay/schema.ts";

import { type BaseLineage, baseLineages, JOURNAL_FILE, onTheBaseLineage } from "./base-lineage.ts";
import { baseRevision, type Event } from "./repo.ts";

/**
 * One property, and it is the one the replay gate cannot reach: **a database
 * built by upgrading equals a database built fresh.**
 *
 * The replay gate proves that every database built by replaying this history
 * from empty comes out the same. A deployed database is not built that way. It
 * holds what the base ref's migrations put there and the journal rows saying
 * so, and the next deploy applies only what that journal does not already name
 * — so an edit to a migration that has already run means the new schema on a
 * fresh database and nothing at all on a deployed one. Nothing errors. The two
 * part company on the day of that commit and stay parted, and the symptom
 * arrives later as a query against a column that exists in three environments
 * and not in the fourth.
 *
 * This is dev-config's upgrade-path gate for the products this repo serves.
 * Their `check.yml` stopped demanding it of a consumer that passes
 * `database: external` — a wrapper replacing the database gates is expected to
 * carry the upgrade duty for its own dialects too — and this is that. The
 * argument, the base-ref table and the refusals are theirs; what is this repo's
 * own is named in docs/gates/db-upgrade.md, and the largest of them is the
 * journal, which the MySQL family keeps one of per database rather than one per
 * lineage.
 */

/** Where the gate replays, what it replays with, and where the evidence goes. */
export interface Upgrade {
  /** The project the calling job declared: where `bun run db:migrate` runs. */
  readonly root: string;
  /** The database the replay gate built from empty, which is what an upgrade has to arrive at. */
  readonly url: string;
  /** The image the job started the server from, which is where the dump's client comes from. */
  readonly image: string;
  /** What the run knows about where it came from. */
  readonly event: Event;
  /** Where the schema reached by upgrading is left. */
  readonly upgraded: string;
}

/**
 * The database the upgrade is replayed into, beside the one the caller
 * declared.
 *
 * Named after the project rather than after a clock, so that one checkout
 * derives one name on every run: reclaiming what a killed run left behind is
 * the next run arriving at the same name and dropping it. Against a server two
 * runs share — which is what this repo's own suite is — deriving it is also
 * what keeps each run dropping its own database rather than the one the other
 * is midway through migrating.
 */
function scratchIn(root: string): string {
  return `upgrade_path_${new Bun.CryptoHasher("sha256").update(root).digest("hex").slice(0, 16)}`;
}

/** The same server, pointing at another of its databases. */
function beside(url: string, database: string): string {
  const swapped = new URL(url);
  swapped.pathname = `/${database}`;
  return swapped.href;
}

/**
 * A database of this gate's own on the caller's server, and gone again
 * whichever way the run went.
 *
 * Dropped before it is created as well as after, so a run killed between the
 * two ends does not leave the next one failing over a name its author never
 * chose. A drop that cannot run at all — the server having gone away under the
 * step — reaches the log rather than the verdict: the error the step is ending
 * on is the one its author has to read, and cleanup that replaced it would cost
 * them the reason.
 */
async function inScratchDatabase<T>(
  url: string,
  name: string,
  body: (scratch: string) => Promise<T>,
): Promise<T> {
  const db = connection(url);
  try {
    await db.unsafe(`drop database if exists \`${name}\``);
    await db.unsafe(`create database \`${name}\``);
  } finally {
    await db.close();
  }
  try {
    return await body(beside(url, name));
  } finally {
    try {
      const after = connection(url);
      try {
        await after.unsafe(`drop database if exists \`${name}\``);
      } finally {
        await after.close();
      }
    } catch (failed) {
      relay(
        `the upgrade gate could not drop ${name}: ${failed instanceof Error ? failed.message : String(failed)}`,
      );
    }
  }
}

/**
 * The clocks a database records as applied, or `undefined` where there is no
 * journal to read.
 *
 * **One journal per database here, which is where this parts company with
 * dev-config's.** Their Postgres migrator puts `__drizzle_migrations` in a
 * schema of its own, so a repo with two lineages has two journal tables and
 * each vouches for one lineage. The MySQL family has no schema layer — the
 * schema is the database — so drizzle's migrator keeps one table, unqualified,
 * and two lineages migrated into one database share one high-water mark. That
 * is drizzle's shape rather than this gate's choice, and it costs the check
 * below its ability to say WHICH lineage a missing clock belongs to when a repo
 * has several; it still says that one is missing.
 *
 * `undefined` rather than an empty set when the table is absent, because the
 * two mean opposite things: no table is a migrator that keeps no journal — the
 * re-runnable kind, which the replay gate's second pass is what grades — and an
 * empty table is a journalled migrator that recorded applying nothing.
 */
async function appliedClocks(url: string): Promise<Set<number> | undefined> {
  const database = databaseIn(url);
  const present = await rowsFrom(
    url,
    "select table_name as name from information_schema.tables where table_schema = ? and table_name = ?",
    [database, JOURNAL],
  );
  if (present.length === 0) return undefined;

  const rows = await rowsFrom(url, `select created_at as clock from \`${JOURNAL}\``, []);
  const clocks = new Set<number>();
  for (const row of rows) {
    const clock = Number(row["clock"]);
    if (Number.isFinite(clock)) clocks.add(clock);
  }
  return clocks;
}

/** The clocks a lineage's journal names — what the migrator records when it applies one. */
function clocksIn({ files }: BaseLineage): number[] {
  const journal = files.find(({ path }) => path === JOURNAL_FILE);
  if (journal === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(journal.text);
  } catch {
    return [];
  }
  const listed = isForeign(parsed) ? parsed["entries"] : undefined;
  if (!isList(listed)) return [];
  return listed.flatMap((entry) => {
    const when = isForeign(entry) ? entry["when"] : undefined;
    return typeof when === "number" ? [when] : [];
  });
}

/** The schema as the server's own client renders it, with what is not schema taken out. */
async function schemaOf(url: string, image: string, client: string, of: string): Promise<Dump> {
  return schemaFrom(of, await dumpOf(url, image, client, DUMP));
}

const CONVERGES =
  "upgrade: a database built from the base ref and migrated by this branch reaches the schema a fresh one gets";

/**
 * What the base ref's migrations built, and then what this branch's do to it.
 *
 * The base phase runs *this branch's* `db:migrate` over the base ref's files,
 * which is the only migrator there is — so what it applied is read back out of
 * the journal rather than assumed. A lineage the base ref carried that the
 * branch's script no longer names would otherwise be missing from both halves
 * and compare equal, while a database deployed from the base ref keeps
 * everything that lineage built.
 */
async function upgraded(
  { root }: Upgrade,
  rev: string,
  lineages: readonly BaseLineage[],
  scratch: string,
): Promise<string[]> {
  const from = rev.slice(0, 7);
  const applied = await onTheBaseLineage(root, lineages, async () => {
    await migrate(
      root,
      scratch,
      `bun run db:migrate failed replaying ${from}'s migrations into ${databaseIn(scratch)} — every lineage directory was rolled back to what ${from} carried, so the statement the output above names is that commit's rather than this branch's`,
    );
    return await appliedClocks(scratch);
  });

  const unapplied =
    applied === undefined
      ? []
      : lineages
          .map((lineage) => ({ dir: lineage.dir, clocks: clocksIn(lineage) }))
          .filter(({ clocks }) => clocks.length > 0 && !clocks.every((clock) => applied.has(clock)))
          .map(
            ({ dir }) =>
              `${from} carries the migration lineage ${dir}, and replaying it left the journal without every migration that lineage names — this branch's db:migrate does not run all of it. A database deployed from ${from} keeps everything that lineage built, so a schema comparison that skipped it on both sides would compare equal and say nothing.`,
          );
  if (unapplied.length > 0) return unapplied;

  await migrate(
    root,
    scratch,
    `bun run db:migrate failed applying this branch's migrations onto ${databaseIn(scratch)}, a database built from ${from} — the output above names the statement; it applies to a database built from empty and not to one ${from} had already migrated`,
  );
  return [];
}

export async function upgradeGate(asked: Upgrade): Promise<Verdict> {
  const { root, url, image, event, upgraded: evidence } = asked;

  // The same refusal the replay gate leads with, and for the same reason: an
  // image with no dump client in it is a wiring fault whose diagnostic is worth
  // more than the replay it would otherwise be found after.
  if (image.trim() === "") {
    return {
      problems: [
        "the database-image input is empty, and it names the image this gate takes its dump client from — the calling job has to pass the same image it started the server from, pinned by digest.",
      ],
    };
  }
  const client = await dumpClientIn(image);
  if (client === undefined) {
    return {
      problems: [
        `${image} ships neither of the dump clients a MySQL-family server image has, so there is nothing here to render a schema with. Pin an image that carries the server's own client.`,
      ],
    };
  }

  const base = await baseRevision(
    root,
    event,
    "the upgrade gate replays the base ref's migrations to prove a deployed database reaches this schema",
  );
  if ("refused" in base) return { problems: [base.refused] };
  if (base.rev === undefined) {
    return {
      note: "upgrade: this commit has no parent in the checkout, so there is no earlier schema to upgrade from",
      problems: [],
    };
  }
  const rev = base.rev;

  const { lineages, problems } = await baseLineages(root, rev);
  if (problems.length > 0) return { problems };
  if (lineages.length === 0) {
    return {
      note: `upgrade: ${rev.slice(0, 7)} carries no migration lineage, so there is no deployed schema to upgrade from`,
      problems: [],
    };
  }

  const scratchName = scratchIn(root);
  return await inScratchDatabase(url, scratchName, async (scratch) => {
    const unapplied = await upgraded(asked, rev, lineages, scratch);
    if (unapplied.length > 0) return { problems: unapplied };

    const reached = await schemaOf(
      scratch,
      image,
      client,
      `the schema upgraded from ${rev.slice(0, 7)}`,
    );
    // Written out as it is taken rather than after a comparison that may never
    // happen: the dump a run never got to compare is exactly the evidence
    // somebody wants.
    await Bun.write(evidence, `${reached.units.join("\n")}\n`);

    const fresh = await schemaOf(url, image, client, "the schema built from empty");
    const changed = compare(fresh, reached);
    if (changed === undefined) return { note: CONVERGES, problems: [] };
    return {
      log: changed.lines.join("\n"),
      problems: [
        `a database built from ${rev.slice(0, 7)} and migrated by this branch does not reach the schema a fresh database gets — ${changed.headline}. A migration that has already been applied is never re-read, so editing one is the new schema on a fresh database and nothing at all on a deployed one: add a migration rather than changing one that has run.`,
      ],
    };
  });
}
