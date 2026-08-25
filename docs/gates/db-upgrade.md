# The upgrade path

`upgrade-gate: true` adds one property to the `database` job: **a database built
by upgrading equals a database built fresh.** The migrations of the base ref are
replayed into a database of this gate's own, this branch's are applied on top of
the result, and the schema that comes out has to be the schema the replay step
already built from empty. Identical, or the step fails.

It is off by default and belongs to repos whose database is deployed somewhere.
Before the first deploy there is nothing to converge on: rewriting, squashing or
regenerating the whole lineage is free, and this gate would go red for work that
is entirely correct. From the first deploy onwards the lineage is a one-way
record, and the gate is what says so.

## Why it is here rather than upstream

dev-config's `check.yml` used to demand its own Postgres upgrade gate of any
repo with a deployed database. It stopped demanding it of a caller that passes
`database: external` — the value that says a workflow wrapping theirs runs the
database gates in that job's place — on the argument that a wrapper replacing
those gates carries the upgrade duty for its own dialects too. This is that
duty, for MariaDB and MySQL 8.

The argument below, the base-ref table and every refusal are dev-config's, and
`upgrade.ts` and `base-lineage.ts` say where each is a checked-in copy of
theirs. What is this repo's own is the journal, and it is at the end of this
page.

## What it catches

Every schema built by replaying a history from empty agrees with every other one
— that is what [the replay gate](db-replay.md) proves. A **deployed** database
is not built that way. It holds what the base ref's migrations put there, plus
the journal rows saying so, and the next deploy applies only what that journal
does not already name.

So an edit to a migration that has already run has two different meanings at
once: on a fresh database it is the new schema, and on every deployed one it is
nothing at all. Nothing errors. The two part company on the day of that commit
and stay parted, and the symptom arrives later as a query against a column that
exists in three environments and not in the fourth.

Two shapes reach that the same way, and the gate refuses both:

- **A migration that has already been applied is edited.** Adding the column to
  the `CREATE TABLE` that made the table, rather than in a new file.
- **A migration is inserted behind one that has already been applied.** What
  rebasing a generated migration under a colleague's produces: the file is new,
  its place in the order is not.

## What drizzle's MySQL migrator actually does

Read out of `drizzle-orm` 0.45.2's own `mysql-core/dialect.cjs` rather than
assumed, since the whole gate rests on it:

- the journal is `__drizzle_migrations`, **in the database being migrated and
  unqualified** — their Postgres migrator puts the same table in a schema of its
  own, and the two spellings are not interchangeable;
- it reads one row — `select id, hash, created_at ... order by created_at desc
limit 1` — and executes a migration only if `created_at < folderMillis`, the
  millisecond `drizzle-kit generate` wrote it into `meta/_journal.json`;
- it records that millisecond beside the SQL's hash. The hash is written and
  never read, so editing an applied migration is a silent no-op.

The journal is a high-water mark and nothing else. A gate that compared
migration files, or checked whether an already-committed migration was touched,
would be guessing at this; replaying it is the only way to be told.

## Which commit counts as the base

| The run                       | The base                                                 |
| ----------------------------- | -------------------------------------------------------- |
| a pull request                | `git merge-base refs/remotes/origin/<base branch> HEAD`  |
| a push                        | `github.event.before` — the tip the branch had before it |
| anything else, or no `before` | `HEAD^`                                                  |
| a first commit                | none: the step passes with a notice                      |

`github.event.before` is the honest answer for a push because it names the
commit whose schema is running somewhere — a push of five commits is one deploy,
not five.

Two ways this could pass by having been handed nothing are refused rather than
skipped: a shallow checkout, and a base branch that is not in the clone. Both
say to check out with `fetch-depth: 0`, which is what `check.yml` does for this
job — unconditionally, because an expression that has to produce `0` rides on
how GitHub casts it.

## How the replay is built

**The lineages come from the base ref, not from this branch.** The set that has
to be replayed is the set that commit carried, read out of it with `git
ls-tree`. Reading the branch's own directories instead would mean a branch that
moved its migrations elsewhere had no lineage to match, and the gate would pass
by not having looked for one.

For every lineage the base ref carried, its files are written over the
directory, the repo's own `bun run db:migrate` runs against the gate's database,
and the branch's own files go back before it runs again — including when the
replay throws. The files move rather than the checkout, because the repo's own
migrator is the only one there is and it reads the one path it was written to
read.

The database is `upgrade_path_<digest of the project directory>`, created on the
server the calling job started and dropped whichever way the comparison goes —
and dropped before it is created, so a run killed between the two ends does not
leave the next one failing over a name its author never chose. The database the
app boots against is the fresh one and is never touched by any of this.

## What it refuses

- **A lineage the base ref carried that this tree does not have** — moved or
  deleted. A deployed database's journal names the migrations that built it, and
  relocating a lineage strands every database that has one.
- **This project's directory having moved**, when git says a lineage moved into
  it with the project.
- **A lineage at the project root, or one inside another.** A lineage is
  replayed by replacing its directory, which is only a local act when that
  directory holds one lineage and nothing else.
- **A file the base tree names outside the lineage directory.** A tree entry can
  be called anything `git mktree` will write, `..` included, and one that
  escapes the directory would not be put back.
- **A lineage the base ref carried whose migrations the branch's `db:migrate` no
  longer runs.** Missing from both halves, it would compare equal — while a
  database deployed from the base ref keeps everything it built.
- **A shallow checkout**, and an image with no dump client in it.

## The journal, which is where this parts company with dev-config's

Theirs matches lineages to journal tables one for one: a Postgres repo with two
lineages has two `__drizzle_migrations` tables, in two schemas, and each vouches
for one lineage. **Neither product here has a schema layer** — the schema is the
database — so drizzle keeps one journal table per database, and two lineages
migrated into one database share one high-water mark.

So the check here asks the weaker question the dialect allows: every clock the
base ref's lineages name has to be in the one journal the replay produced. A
repo with several lineages is told that one of them was not applied, without
being told which. A repo with one — which is both consumers — gets the same
answer theirs would give.

Where there is no journal table at all, the check is skipped rather than failed:
that is a migrator that keeps no journal, the re-runnable kind, and what grades
it is the replay gate's second pass.

## What it cannot see

- **Rows.** `--no-data` on both dumps. What a migration does to the data in a
  deployed database is not asked here — dev-config's `semantic-fixtures` is that
  question, and this repo does not carry it yet
  ([#4](https://github.com/gokayo43/dev-config-db/issues/4)).
- **A backfill.** Same issue, same reason.
- **Anything about a database deployed from further back than the base ref.**
  One hop is what this proves.
- **A migration killed midway.** Neither product has transactional DDL, so a
  migration interrupted between two statements leaves half of itself applied,
  and nothing here exercises that.
- **Two deploys at once.** There is one writer.
