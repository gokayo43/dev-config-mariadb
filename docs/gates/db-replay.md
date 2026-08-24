# The replay gate

`database: true` adds the `database` job, and these are its first steps: an
empty MariaDB — plus a Redis, for the repos whose migrator imports an
environment module that wants one — the consumer's own `bun run db:migrate` onto
it, then the same command again, and the two schemas compared. What the same job
does afterwards, with the database these steps built, is
[db-serving.md](db-serving.md).

An empty database is the one state no developer machine is ever in, and it is
the state every deploy to a new box and every restore drill starts from. A
migration carrying `ALTER TABLE ... ADD COLUMN` for a table an earlier migration
has already dropped is the shape that gets through: it succeeded on the database
it was written against, where that table was still there, and aborts the first
time the history runs onto nothing — a database that cannot be rebuilt,
discovered at the worst possible moment. Replaying from empty on every push is
what turns that into a red build.

The migrations then run a second time, and the gate is not the exit code but the
schema either side of it. An exit code only says the second run did not error;
the dump says the database came out in the same state, which a runner with no
journal can exit 0 without doing — MariaDB accepts an unnamed `ADD CHECK` twice
and names the second one for itself, and neither run complains. With a
journalled migrator the pass is cheap and proves the journal is honest; with
anything that re-executes SQL, it proves the SQL is re-runnable.

## What "the same schema" is

`mariadb-dump --no-data --skip-dump-date --routines --events --triggers`, run
twice, compared line by line in the order the dump wrote them. `mariadb-dump`
renders the catalogue in a fixed order, so two dumps holding the same statements
in a different arrangement really are two different databases; nothing is sorted
and nothing is reordered.

Routines and events are asked for because they are not in the tool's defaults. A
schema that left them out would call a repo's stored procedures unchanged
whatever had happened to them, and — the sharper half — would call a migration
set that builds only a routine a migration set that built nothing.

### What is taken out, and why it is one class

A dump carries three lines that are not schema. They are one kind of fact —
**how many values an object has handed out, and when an object was last
created** — and each is rewritten by an ordinary migration doing an ordinary
thing, so a comparison that kept them refuses a repo that is fine.

| Line                                 | What it records                                                                                                                                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `) ENGINE=… AUTO_INCREMENT=<n> …`    | the id the table would hand out next. A migration that seeds a row moves it, and so does a migrator writing its own journal. Taken out on the line that closes the `CREATE TABLE` — a column's own `AUTO_INCREMENT` carries no `=`, so nothing inside a table definition is touched. |
| `DO SETVAL(<seq>, <next>, <cycles>)` | the value a sequence would hand out next. One `NEXTVAL` moves it, by a thousand at the default cache of 1000. The sequence's own shape — start, min, max, increment, cache, cycle — is on the `CREATE SEQUENCE` line above and is compared in full.                                  |
| `EVENT … STARTS '<stamp>'`           | when the event was created. An event with no explicit `STARTS` is stamped with its creation time, and the idiomatic re-runnable migration for one is `DROP EVENT IF EXISTS` followed by `CREATE EVENT` — which re-creates it, and re-stamps it, on every replay.                     |

The membership was swept rather than guessed. A database carrying a table, a
sequence, a view, a procedure, a function, a trigger and an event, put twice
through the re-runnable idioms a migration is written in — `CREATE TABLE IF NOT
EXISTS` with an insert, `CREATE OR REPLACE VIEW`, `DROP … IF EXISTS` before each
`CREATE` — moved exactly those three lines and no others. Every `DEFINER`, every
`sql_mode` block, the sequence's own definition and the whole compatibility
preamble came out byte-identical.

That is the measurement, and it is a measurement of **the comparison this gate
actually makes**: two dumps with a migrator run between them, not two dumps of
an untouched database a second apart. The second is a much weaker claim and it
is the one that hid two of the three lines above.

So a line that moves and is not on that table is a line worth failing over. What
the exclusions cost is named under "What this cannot catch".

A red run names **where** the two part. Both dumps come from one tool through
one split, so index `n` is line `n + 1` of both files: the gate walks them in
step to the first line they disagree on, puts that line number and both sides'
line on the annotation, and prints each side's own lines from there into the
log. That tail is bounded — one inserted line makes every later line differ, so
an unbounded one would print most of the schema on the commonest failure there
is — and what is cut is counted rather than dropped. Both dumps leave the run
whole in the artifact, so the log's job is to point rather than to reproduce.

There is no such thing as a refusal with nothing under it, and it takes two
things to keep that true.

The comparison always has something to say: each side contributes at least the
sentence naming where it parted, so a difference with an empty log cannot be
built. The way to fail _that_ is a comparison that subtracts two sets and finds
nothing left over, which is exactly
[dev-config#70](https://github.com/gokayo43/dev-config/issues/70).

And what it has to say has to survive the trip to the log. The runner reads its
own commands off the same stdout, matching `::` once a line's leading whitespace
is trimmed — so a dump line that trims to `::stop-commands::` would silence every
annotation the gate is about to make, and a step that failed would go red with
nothing rendered. A schema dump is text the graded repo wrote (a routine body
holds whatever its author typed), so it is relayed behind a `| ` margin that
cannot be trimmed away rather than printed. The consuming repo's own migrator
output goes the same way, for the same reason and by an easier route.
[dev-config#71](https://github.com/gokayo43/dev-config/issues/71) is both holes
upstream.

## Where the client comes from

The dump is taken by the `mariadb-dump` inside the **same image the job runs the
server from**, through `docker run --network host`. Two reasons, and the second
is the one that matters:

- nothing on a GitHub runner ships a MariaDB client at all, and an `apt install`
  would put an unpinned package inside a gate whose whole argument is that what
  it runs is pinned;
- a client of another major renders a schema it half understands. Taking it from
  the server's own image makes them one build rather than two versions that
  agree today. dev-config carries the Postgres half of this as
  [dev-config#64](https://github.com/gokayo43/dev-config/issues/64).

The image is written twice in `check.yml` — once as the service, once as the
`db-image` the action is handed — because GitHub gives a service image no way to
read a value declared anywhere else. `tests/wrapper-inputs.test.ts` is what holds
the two to one digest; a drift between them is the worst kind of quiet, since
the gate would render one major's catalogue with another major's client and
compare the two renderings to each other.

## What the gate refuses before it replays anything

Both are the same failure wearing two faces: a gate that was handed nothing
passes, and the pass reads exactly like a history that rebuilds.

- **No `db:migrate`.** Answerable from `package.json` alone, and asked before
  anything costs a migrator run. Without it the diagnostic would be the first
  replay's — a sentence about a statement that would not apply, for a script
  that is not there.
- **A database something has already been in.** The gate's claim is that these
  migrations built this schema. Against a database another migrator, an init
  script or a previous run has been in, that claim is about the two of them
  together and nobody can tell which built what.
- **A `db:migrate` that succeeds and builds nothing.** Read off the catalogue
  afterwards, with the migrator's own journal excluded: drizzle's MySQL migrator
  keeps `__drizzle_migrations` **in the database being migrated**, unqualified —
  its Postgres migrator puts the same table in a schema of its own — so a run
  that recorded having applied nothing still leaves one table behind, and
  counting it as schema is how a repo with no lineage at all passes.

## Evidence

Both schemas leave the run in the artifact `db-gate-evidence` names, defaulting
to `db-gate-evidence`, alongside everything the steps after this one left behind
— [db-serving.md](db-serving.md) lists those and says why one job leaves one
artifact.

Each schema is written as it is taken rather than after a comparison that may
never happen — the dump a run never got to compare is exactly the evidence
somebody wants — so a refusal on the second replay ships both, and a refusal on
the first ships neither.

They are named `.schema` rather than `.sql` for what they are: what the step
compared, with each table's counter taken out. Feeding one back would build a
database whose counters start over.

## What this cannot catch

Named rather than papered over, because a gate whose limits are undocumented
gets trusted for things it never checked.

- **Whether the schema is right.** That a history rebuilds says nothing about
  whether what it builds is what the app needs.
- **A change to one of the three excluded lines.** A migration that deliberately
  set a sequence's position, or wrote an absolute `STARTS` and then changed it,
  is invisible here. Both replays run one lineage, so neither can differ between
  them for a reason the author chose — but a gate comparing two _different_
  lineages, which the upgrade path will, has to decide this again rather than
  inherit it.
- **Anything about a deployed database.** Both replays here start from empty. A
  migration that has already been applied somewhere is never re-read by a
  journalled migrator, so a rewritten one changes what a fresh database gets and
  nothing else — that is the upgrade path, and it is
  [#4](https://github.com/gokayo43/dev-config-mariadb/issues/4).
- **Rows.** `--no-data`: what a migration writes into a table is invisible here,
  and two databases whose schemas match can hold entirely different data.
- **A migration killed midway.** Both runs go to completion. MariaDB has no
  transactional DDL, so a migration interrupted between two statements leaves
  half of itself applied and nothing here exercises that.
- **Two of them at once.** There is one writer, so nothing about racing
  migrators is exercised.
- **Any server that is not the pinned image.** The consumer's production MariaDB
  is a different build with a different configuration, and a schema that applies
  on one can fail on the other over `sql_mode` alone.
