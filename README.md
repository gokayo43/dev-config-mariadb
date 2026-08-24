# dev-config-mariadb

The MariaDB extension of [`@gokayo43/dev-config`](https://github.com/gokayo43/dev-config).
One reusable workflow: a consuming repo calls it instead of dev-config's
`check.yml` and gets that gate unchanged, plus the database jobs a MariaDB repo
needs.

Nothing here is a copy of dev-config. The static half is a call into it, pinned
by commit SHA, so a gate lands here when the pin moves and never because a fork
drifted.

## Scope

Two repos, both older than the fleet's Postgres decision: `nfp-elysia` and
`wmstcs`. dev-config's database job replays migrations onto Postgres, and it
stays Postgres — a base that grew a second dialect would carry the choice into
every repo that has no MariaDB. This workflow is where the second dialect lives
instead. A new project consumes dev-config directly; nothing else is a reason to
call this one.

The database jobs are MariaDB and only MariaDB. `nfp-elysia`'s server is MariaDB
11.4; `wmstcs`'s is MySQL 8.0, which is close enough to share a dialect and not
close enough to share a server image or a dump client —
[#9](https://github.com/gokayo43/dev-config-mariadb/issues/9) is where that lane
is decided. Until it lands, a MySQL consumer is refused by the pinned image
rather than graded against another server's idea of a schema.

## Calling it

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    uses: gokayo43/dev-config-mariadb/.github/workflows/check.yml@<commit sha> # <release tag>
    with:
      build: true
      database: true
      contract-exemptions: ci-call
```

`ci-call` is part of the call rather than a shortcut: dev-config's repo contract
asks a repo to call **dev-config's** `check.yml` at a pinned SHA, and a repo
pointing at this workflow has that call one level down where the contract cannot
read it. [dev-config#65](https://github.com/gokayo43/dev-config/issues/65) is
where teaching the contract to see this workflow is argued; until it lands, a
consumer that also declares `lifecycle: "live"` and owns migrations is refused
by that contract for a Postgres job this workflow deliberately leaves off, which
is the other half of the same issue.

| Input                 | Type      |
| --------------------- | --------- |
| `build`               | `boolean` |
| `affected`            | `boolean` |
| `compose`             | `boolean` |
| `mutation-lane`       | `boolean` |
| `mutation-floor`      | `string`  |
| `contract-exemptions` | `string`  |
| `stack-allowlist`     | `string`  |
| `test-network`        | `string`  |
| `test-suite-evidence` | `string`  |
| `database`            | `boolean` |
| `db-gate-evidence`    | `string`  |
| `start-command`       | `string`  |
| `health-url`          | `string`  |
| `probe-command`       | `string`  |
| `probe-timeout`       | `string`  |
| `capacity-script`     | `string`  |
| `capacity-path`       | `string`  |
| `route-allowlist`     | `string`  |

The first nine are handed to dev-config's `check.yml` unchanged, so
[its README](https://github.com/gokayo43/dev-config#ci) is the reference for
what one does and for the conditions under which it refuses one. The inputs
here carry no description of their own for that reason — a second copy of that
prose is a copy that drifts — and the one exception says what dev-config
cannot: that a consumer of this workflow owes `ci-call`.

The other nine are this workflow's own and reach dev-config's `check.yml` under
no name at all. They are spelled the way dev-config spells the same nine, and
mean here what they mean there against another server: `database` adds the
database job below, `db-gate-evidence` names the artifact it leaves behind, and
the seven after them aim its boot, probe and ramp steps —
[docs/gates/db-serving.md](docs/gates/db-serving.md) is what each one does. A
consumer that moves between the two workflows writes one call either way.

`tests/wrapper-inputs.test.ts` is what keeps every list on this page honest: it
reads the dev-config this repo installs — the same commit the workflows call —
and fails on a type or default of this wrapper's own, on an input declared that
nothing reads, and on a name this page has stopped accounting for.

Every other input dev-config's `check.yml` declares is refused here rather than
forwarded: `upgrade-gate`, `semantic-fixtures`, `timestamp-allowlist`,
`backfill-seed` and `backfill-command`. Each is aimed at a step of the Postgres
database job this workflow leaves off, and the jobs below are what will answer
them for MariaDB.

Passing any input aimed at this repo's own database job without asking for that
job is refused rather than ignored, which is what the `refusals` job is for.
`start-command` and `health-url` are the two that cannot be asked that way —
they carry a default rather than an empty one, so "the caller passed this" has
no spelling a workflow can read — and
[dev-config#66](https://github.com/gokayo43/dev-config/issues/66) is the same
two going unrefused upstream. They are compared with their declared defaults
here instead; `docs/gates/db-serving.md` names the one caller that leaves
invisible.

`db-gate-evidence` is asked the same question this workflow's own job can ask:
passing it with `database: false` fails the run rather than being ignored, since
it names an artifact nothing would have uploaded. Its default is a constant, and
an artifact name may be claimed once per run — so a caller running this workflow
as a **matrix** gives each leg its own, and keeps it distinct from
`test-suite-evidence`, exactly as dev-config's README describes for its own two.

## The jobs

| Job                       | What it runs                                                                                                                                                                                                                                                                                                                   | Status                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `refusals`                | the one rule this workflow adds rather than delegates: a call asking for an input aimed at a database job, without that job, is refused rather than ignored                                                                                                                                                                    | shipped                                                                 |
| `static`                  | dev-config's `check.yml` with `database: false`: the secret scan, the repo contract, the stack denylist, the workflow lint, suppression hygiene, shell scripts, `format:check` / `lint` / `typecheck` / `knip`, the test suite, and — each where the caller asks for it — the compose lint and the mutation lane               | shipped                                                                 |
| `database`                | the repo's `db:migrate` onto an empty MariaDB, twice, compared as normalized schema dumps — [docs/gates/db-replay.md](docs/gates/db-replay.md) — and then, against that database, the app booted, the repo's own probe run, and a k6 ramp with the route-coverage floor — [docs/gates/db-serving.md](docs/gates/db-serving.md) | shipped                                                                 |
| upgrade path and backfill | the base ref's lineage upgraded and compared with a fresh build, and a backfill run twice                                                                                                                                                                                                                                      | planned ([#4](https://github.com/gokayo43/dev-config-mariadb/issues/4)) |
| DATETIME wall clock       | every `DATETIME` column carries a reasoned allowlist entry, MariaDB's half of the ambiguous-instant class                                                                                                                                                                                                                      | planned ([#5](https://github.com/gokayo43/dev-config-mariadb/issues/5)) |
| integration lane          | the repo's DB-touching suite against a real MariaDB and Redis, with the junit report read afterwards                                                                                                                                                                                                                           | planned ([#6](https://github.com/gokayo43/dev-config-mariadb/issues/6)) |

## Gating this repo

`.github/workflows/ci.yml` calls dev-config's `check.yml` directly rather than
the workflow beside it: a commit cannot pin its own SHA, so the wrapper would
gate every review against the dev-config of one commit ago. Both files name one
dev-config commit, and the suite fails when they stop agreeing.

```sh
bun install
bun run check   # format:check + lint + typecheck + knip
bun test        # needs Docker: the replay gate's suite drives a real MariaDB
```

The suite starts one MariaDB container per worktree and takes it down again, so
`bun test` needs a Docker daemon it can reach. It also starts a real app on a
real port, which is what the boot, probe and ramp gates are graded against. It
is not sealed the way every other repo's suite is: dev-config's test-suite gate
runs `bun test` in a network namespace holding nothing but its own loopback, and
a container's published port is on the runner's. `test-network` in `ci.yml` is
the reason for that, written where it is read in review.

Beside that call, `ci.yml` carries one job of its own: the k6 ramp shipped with
the serving gate, executed under the k6 that gate pins. Nothing in `bun test`
may fetch a binary, and "it runs inside k6" is not a reason for nothing to have
run the file.

## Pins

The call is pinned by commit SHA with the release as a trailing comment, in both
workflows. `renovate.json` extends dev-config's preset, which reads a job-level
`uses:` like any other dependency and holds dev-config's own pins back from
automerge — a bump here is a gate landing in two repos, and it is read before it
is merged.
