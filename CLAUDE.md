# dev-config-mariadb

The MariaDB extension of `gokayo43/dev-config`, for the two legacy repos whose
database is MariaDB. `CONTEXT.md` is the vocabulary; `README.md` is the
reference for how a consumer calls this workflow and what each job does.

## Canon

The house rules live outside this repo and win over anything here:
`~/claude-shared/STACK.md`, `architecture.md`, `testing.md`, `principles.md`.
dev-config is where most of them are already executable — this repo adds the one
thing that could not live there.

## The rule this repo exists to keep

**It only adds.** No gate here loosens one of theirs, and the static half is a
call rather than a fork. A change that would be better made in dev-config is
made in dev-config: this repo is for what is MariaDB-shaped and nothing else.
Anything that reads as "the base should have this too" is an issue there, not a
second implementation here.

**The one carve-out: the gate library.** A composite action runs from a checkout
of its own repo with no `node_modules` above it, and `.github/` is outside
dev-config's `files` allowlist — so nothing under `.github/actions/` here can
import from the dev-config this repo installs, by any route. Two files are
therefore checked-in copies of theirs at the pinned SHA, and each says so in its
own header with its deltas named: `_lib/annotations.ts` (their `_lib/gate.ts`)
and the three functions `db-replay/database.ts` names (`databaseIn`, `migrate`,
`rowsIn`). [dev-config#69](https://github.com/gokayo43/dev-config/issues/69) is
where ending that is argued.

The carve-out is for what the runtime makes unreachable, and nothing else. It is
not licence to fork a gate: an assertion, a diagnostic or a rule that could live
in dev-config still belongs there. And it cuts both ways — a bug fixed there is
a bug still here until somebody carries it over, and two fixes have so far gone
the other way ([dev-config#70](https://github.com/gokayo43/dev-config/issues/70),
[#71](https://github.com/gokayo43/dev-config/issues/71)), which is why a copy
that has been improved says so at the line that improved it.

## Layout

- `.github/workflows/check.yml` — the wrapper consumers call. Three jobs: the
  call into dev-config's `check.yml` with `database: false`, the always-running
  `refusals` job that fails a call asking for a database-job input without the
  job, and `replay` (`#2`). The remaining MariaDB database jobs land beside them
  (`#3`–`#6`), each with the composite action that runs it, its own suite, and
  its page under `docs/gates/` — the shape dev-config's "Adding a gate"
  describes.
- `.github/workflows/ci.yml` — this repo's own gate, which is dev-config's
  `check.yml` called directly. It cannot be the wrapper: a commit cannot pin its
  own SHA, so the wrapper's pin is always one commit behind whatever is under
  review.
- `.github/actions/` — the gates themselves, one directory per job, each a
  `<name>.ts` the suite drives and a `<name>.main.ts` the action runs. Beside
  them: `db-replay/database.ts` is everything that talks to a server, and
  `db-replay/schema.ts` is the pure comparison two schemas go through — split so
  that `#3`–`#6` can reuse the second without the first. `_lib/` is what every
  action shares: `annotations.ts` (the log protocol) and `foreign.ts` (the one
  place a document nobody here wrote is narrowed).
- `tests/` — what CI cannot see from outside. `wrapper-inputs.test.ts` grades
  the wrapper and the README against the dev-config in `node_modules`, which is
  the commit the workflows call: every input the wrapper hands on reaches the
  call under its own name, every input it declares is read by something and is
  declared with dev-config's own type and default, nothing is forwarded that
  dev-config does not declare, the call carries exactly one literal and it is
  `database: false`, only one job calls that workflow at all, what the README
  tables and what it says is refused cover dev-config's input surface exactly,
  the four carriers of the dev-config pin agree, the action pin names a commit
  this repo carries, and the server image is written once as far as a reader is
  concerned. `refusals.test.ts` runs the wrapper's own `run:` block — extracted
  from the shipped YAML rather than transcribed — over the whole truth table of
  the one behavioural rule this workflow adds. The rest of the suite drives the
  gates against real MariaDB containers it starts and removes itself, which is
  why `ci.yml` sets `test-network`.

## The server this repo is written against

MariaDB 11.4, because that is what `nfp-elysia` runs (probed: `11.4.12-MariaDB`).
`wmstcs`, the other repo `README.md` names, runs **MySQL 8.0.32** — same dialect
family, different server, and a different dump client binary. There is no lane
for it and the pinned image refuses it;
[#9](https://github.com/gokayo43/dev-config-mariadb/issues/9) is that decision,
and it is blocked on [dev-config#68](https://github.com/gokayo43/dev-config/issues/68),
which is why the obvious fix — a `db-image` input — could not be written.

## Moving the dev-config pin

Four files carry it — both workflows, `package.json` and `bun.lock` — and the
suite requires all four to name one commit: a repo gated by one dev-config,
shipping another and grading its own wrapper against a third has no answer about
any of them. Renovate raises the bump as a PR (`renovate.json` extends
dev-config's preset, which keeps that pin off automerge); the tag in the trailing
comment moves with the SHA, and `bun install` is part of adopting it.

Renovate reaches the manifest through a different oracle than the workflows —
digest against dev-config's default branch, tag for the two `uses:` — so a bump
raised while dev-config's `main` sits ahead of its latest tag arrives with the
carriers disagreeing, and the suite fails on that PR. Point all four at the
tagged commit by hand when it happens.
[#8](https://github.com/gokayo43/dev-config-mariadb/issues/8) is the decision
about ending that, including why the obvious fix — a tag in the manifest — is
refused by dev-config's own contract.

## Releasing an action

A commit cannot reference its own SHA, and inside a called workflow a relative
`uses:` resolves against the **caller's** checkout — so the wrapper reaches this
repo's actions by full path and SHA, and an action and the workflow pinning it
are two commits. dev-config carries the same shape; `check.yml` there is v0.50.1
pinning actions at v0.50.0.

Two consequences, both live now that `#2` has shipped one:

- **A change to an action is two commits**, the second re-pinning the first.
  `tests/wrapper-inputs.test.ts` fails when the pin names a commit this repo
  does not carry, which is the loud half.
- **The pinned commit has to survive.** A squash merge orphans it, and an
  orphaned pin is an action GitHub cannot fetch — a database job that fails for
  every consumer at once. Tagging the release is what keeps it reachable, and
  until this repo has a release, merging without squashing is what stands in.

## Commands

```sh
bun run check   # format:check + lint + typecheck + knip
bun test
```

## Adoption

Neither consumer calls this workflow yet: `wmstcs` is a pnpm/Node repo and
`nfp-elysia` has no CI workflow at all, so both need the fleet scaffold before
the wrapper is worth pointing at. Two things in dev-config's repo contract
refuse a consumer of this workflow on facts that are about dev-config's own
Postgres job rather than about the repo —
[dev-config#65](https://github.com/gokayo43/dev-config/issues/65) carries both,
and `README.md`'s call example carries the `ci-call` exemption that is the
answer until it lands.
