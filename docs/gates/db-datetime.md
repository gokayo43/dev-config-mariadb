# The DATETIME gate

`database: true` adds this to the `replay` job, as the step after the
migrations: the database that replay just built is asked which of its columns
are `DATETIME`, and every one of them has to carry a reasoned entry in
`datetime-allowlist` or the step goes red naming it.

MariaDB's two datetime types are not two spellings of one thing, and they are
the other way round from what a Postgres reader expects.

`TIMESTAMP` is the safe one. The server converts a value to UTC on the way in
and back to the session's zone on the way out, so the instant survives the trip.
Probed on the pinned image, `11.4.12-MariaDB`:

```
set time_zone = '+00:00'; insert into zones values ('2024-06-01 12:00:00', '2024-06-01 12:00:00');
set time_zone = '+05:00'; select ts, dt from zones;
  ts                    dt
  2024-06-01 17:00:00   2024-06-01 12:00:00
```

`DATETIME` is the `dt` column: the digits someone typed, kept, with nothing
recorded about which clock produced them. One row means two different instants
either side of a DST boundary or a server move, and nothing fails until it does
— a booking an hour out twice a year, a "created 45 minutes from now", an audit
trail that disagrees with itself about the order two things happened in.

The database is asked directly, through `information_schema.columns`. An ORM's
`datetime()` is a hint and the catalogue is the fact — a column a migration
altered by hand, a generated column no schema file mentions, and a view's own
column are all in the answer and none of them is in a schema file.

## The allowlist

`datetime-allowlist` takes `table.column -- why` entries, one per line, for the
columns where the wall-clock reading is the point.

```yaml
with:
  database: true
  datetime-allowlist: |
    opening_hours.opens_at -- the shop's own clock, 09:00 wherever it is
    contract.expires_on -- a calendar deadline the customer reads in local time
```

**The name is `datetime-allowlist`, not dev-config's `timestamp-allowlist`.**
Each names the ambiguous type of its own server, and here that spelling would
name the safe one — so the wrapper refuses `timestamp-allowlist` rather than let
a MariaDB reader meet the rule backwards.

**A bare `table.column`, and that is the other deliberate difference.** Their
`timestamp-allowlist` keys `schema.table.column`, because a Postgres database
holds schemas and `app.events.occurred_at` and `public.events.occurred_at` are
two different columns. MySQL and MariaDB have no such layer — the schema **is**
the database — so once this gate has fixed the database, `table.column` names
exactly one column and a third part would name nothing.

Fixing the database is not tidiness either. A Postgres connection can see one
database; a MySQL-family connection can see every database on the server, and on
a stock server of the pinned image `information_schema`, `mysql` and `sys` carry
36 `DATETIME` columns between them (probed). Unfiltered, this gate would open
with three dozen refusals for columns no consumer's migrations wrote and no
consumer can convert.

Entries are one per line rather than space-separated because an identifier can
hold a space: `` `opening hours` `` and `` `opens at` `` are legal names, and
`opening hours.opens at -- why` is how one is waived.

**The column is matched whatever its case; the table is not.** That is the
server's own rule rather than a convenience, probed on the pinned image at its
default `lower_case_table_names = 0`: `select shop.OPENS_AT` reads `opens_at`,
while `SHOP` is a table `shop` does not answer to — `Shop` and `shop` can both
exist, holding different columns. So `shop.OPENS_AT -- why` waives `opens_at`
and `Shop.opens_at -- why` waives nothing in `shop`. A gate that folded the
whole key would let an entry for one table waive a `DATETIME` in another.

Each entry carries `-- why`, the same price a lint directive pays: an exemption
nobody had to justify is one nobody can review a year later. An entry without a
reason fails the step — and still exempts its column, because reporting the
column as well would be two diagnostics for one mistake.

An entry is refused when nothing under grade answers to it, which is the other
half of the same rule. The step reads every column in the database, not only the
`DATETIME` ones, so it can say which of the two ways an entry died:

- the column is here and is not `DATETIME` — there is nothing to waive, so the
  entry goes. The gate says that and no more: a column converted since the entry
  was written and a column that never was one are the same single row in the
  catalogue, and which of them happened is not something a schema records;
- the database has no column of that name at all — dropped, renamed, or never
  spelled the way the entry spells it, so the entry goes or the name does.

Nothing suppresses that check. The catalogue is one query, which either answered
in full or threw and ended the step; there is no half-read universe here for a
dead entry to be an artefact of.

## What is graded, and what is not

`DATETIME` and nothing else, and the set has one member for reasons rather than
by omission.

| Type                        | Graded | Why                                                                                                                                                      |
| --------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATETIME`, `DATETIME(n)`   | yes    | the wall-clock type. Both spellings report `datetime` as their `data_type`, which is what this reads — keying on `column_type` would grade the precision |
| `TIMESTAMP`, `TIMESTAMP(n)` | no     | the fix, not the fault: UTC on the way in, the reader's zone on the way out                                                                              |
| `DATE`, `TIME`, `YEAR`      | no     | never claimed to be instants. A birthdate is a date, and grading these would ask every consumer to justify every one it stores                           |

There is no array type in MariaDB, so there is no analogue of the second member
dev-config's gate carries (`_timestamp`, a Postgres array of wall-clock
timestamps).

A **view** is graded like a table, and it costs the honest case nothing: a view
that selects a `TIMESTAMP` column through reports `timestamp`, while
`cast(ts as datetime)` reports `datetime` (both probed). That cast is a real way
a zone is thrown away with no migration saying so, and the consumer reading the
view gets the ambiguous digits either way.

The migrator's own journal is graded like anything else. With drizzle's MySQL
migrator that costs nothing — `__drizzle_migrations` records its clock as a
`bigint` — but a migrator whose bookkeeping used a `DATETIME` would need an
entry, with the reason being that it is not this repo's table.

## The first adoption will be a long one

Both repos this workflow is for are older than the fleet's Postgres decision,
and both will arrive with a long list. Counted in their own trees rather than
guessed: `nfp-elysia`'s drizzle schema declares 26 columns with `datetime()`
beside 70 with `timestamp()`, and `wmstcs`'s Prisma schema declares 103
`DateTime` fields with no native-type override — which its own checked-in
migration SQL renders as `DATETIME(3)`. Neither number is a ceiling; the
catalogue is what this gate reads, and a column an ORM never mentioned counts
too.

So turning `database: true` on for the first time will not produce a short list.
Every column is then a real decision — convert it to `TIMESTAMP`, or write down
why its digits really are a wall-clock reading — and that decision is the whole
point of the gate rather than an obstacle in front of it. Two things are worth
knowing before starting:

- **A conversion is a data migration, not a type change.** `ALTER TABLE … MODIFY
… TIMESTAMP` re-reads every existing value as if it were in the session's
  current zone. If the rows were written under another zone, that is the moment
  the error is baked in.
- **`TIMESTAMP` cannot hold an instant after 2038-01-19.** Probed: under
  `STRICT_ALL_TABLES` the pinned server refuses `'2039-01-01 00:00:00'` for a
  `TIMESTAMP` column with `ERROR 1292`, and accepts it for a `DATETIME`. A
  column that stores far-future dates is a legitimate allowlist entry, and its
  reason should say so.

## What this cannot catch

Named rather than papered over, because a gate whose limits are undocumented
gets trusted for things it never checked.

- **A wrong instant in a `TIMESTAMP`.** The type carries the zone; nothing here
  says the value was right when it was written. A row written by a process whose
  session zone was wrong is wrong in the safe type too.
- **An instant stored as text or a number.** A `varchar` holding
  `'2024-06-01 12:00'`, or a `bigint` of epoch seconds, is invisible to a gate
  that grades types — and the first is exactly what a repo migrating away from
  `DATETIME` might reach for.
- **What the application does with the value.** A `TIMESTAMP` read by code that
  formats it in the server's zone and mails it to a customer in another one is a
  bug this gate has nothing to say about.
- **Whether an allowlist entry's reason is true.** The gate enforces that a
  reason was written, not that it is honest. That is a review, and the entry is
  in the call for a reviewer to read.
- **A column whose name contains `` ` -- ` ``** — the separator with a space
  either side, which is the whole of it: `dashes.a--b -- why` waives `a--b`
  cleanly (probed), and only the spaced spelling collides. MariaDB accepts
  `` `a -- b` `` as an identifier, an entry for it is read as a subject and a
  reason nobody wrote, and the column cannot be waived. Renaming it is the fix,
  and no consumer has one.
- **A column whose name contains a newline.** Probed: `` `a\nb` `` is a legal
  identifier and the catalogue reports it as one. Entries are one per line, so
  an entry for it is read as two subjects nobody wrote — same shape as the
  limit above, and the same fix.
- **A table whose name contains a dot.** `` `a.b` ``.`c` and `a`.`` `b.c` ``
  both spell `a.b.c`, so one entry waives both. Same shape as dev-config's key,
  which a schema, table or column containing a dot collides in the same way.
- **A database that is not the one this job built.** Every claim here is about
  the catalogue of the database the replay migrated, on the pinned image. The
  consumer's production server is a different build with a different
  configuration, and its `sql_mode` decides what a conversion does to the rows
  this gate never sees.
