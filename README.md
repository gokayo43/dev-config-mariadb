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

Each is handed to dev-config's `check.yml` unchanged, so
[its README](https://github.com/gokayo43/dev-config#ci) is the reference for
what one does — repeated here, the description would be a copy to drift.
`tests/wrapper-inputs.test.ts` is what keeps the list above honest: an input
declared and not handed on is a setting a consumer wrote that nothing reads.

The eleven inputs aimed at dev-config's own database job — `upgrade-gate`,
`semantic-fixtures`, `capacity-path`, `capacity-script`, `db-gate-evidence`,
`route-allowlist`, `timestamp-allowlist`, `backfill-seed`, `backfill-command`,
`probe-command` and `probe-timeout` — are not accepted here. That job is
Postgres and this workflow leaves it off; the jobs below are what answers those
questions for MariaDB.

## The jobs

| Job                       | What it runs                                                                                                                                                                                                                                                                        | Status                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `static`                  | dev-config's `check.yml` with `database: false`: the secret scan, the repo contract, the stack denylist, the workflow lint, suppression hygiene, shell scripts, `format:check` / `lint` / `typecheck` / `knip`, the test suite, and the mutation lane where the caller asks for one | shipped                                                                 |
| replay                    | the repo's `db:migrate` onto an empty MariaDB, twice, compared as normalized schema dumps                                                                                                                                                                                           | planned ([#2](https://github.com/gokayo43/dev-config-mariadb/issues/2)) |
| boot, probe and ramp      | the app booted against the migrated database, the repo's own probe, and a k6 ramp with the route-coverage floor                                                                                                                                                                     | planned ([#3](https://github.com/gokayo43/dev-config-mariadb/issues/3)) |
| upgrade path and backfill | the base ref's lineage upgraded and compared with a fresh build, and a backfill run twice                                                                                                                                                                                           | planned ([#4](https://github.com/gokayo43/dev-config-mariadb/issues/4)) |
| DATETIME wall clock       | every `DATETIME` column carries a reasoned allowlist entry, MariaDB's half of the ambiguous-instant class                                                                                                                                                                           | planned ([#5](https://github.com/gokayo43/dev-config-mariadb/issues/5)) |
| integration lane          | the repo's DB-touching suite against a real MariaDB and Redis, with the junit report read afterwards                                                                                                                                                                                | planned ([#6](https://github.com/gokayo43/dev-config-mariadb/issues/6)) |

## Gating this repo

`.github/workflows/ci.yml` calls dev-config's `check.yml` directly rather than
the workflow beside it: a commit cannot pin its own SHA, so the wrapper would
gate every review against the dev-config of one commit ago. Both files name one
dev-config commit, and the suite fails when they stop agreeing.

```sh
bun install
bun run check   # format:check + lint + typecheck + knip
bun test
```

## Pins

The call is pinned by commit SHA with the release as a trailing comment, in both
workflows. `renovate.json` extends dev-config's preset, which reads a job-level
`uses:` like any other dependency and holds dev-config's own pins back from
automerge — a bump here is a gate landing in two repos, and it is read before it
is merged.
