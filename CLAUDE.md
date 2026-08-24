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

**It only adds.** No file here is a copy of a dev-config file, no gate here
loosens one of theirs, and the static half is a call rather than a fork. A
change that would be better made in dev-config is made in dev-config: this repo
is for what is MariaDB-shaped and nothing else. Anything that reads as "the base
should have this too" is an issue there, not a second implementation here.

## Layout

- `.github/workflows/check.yml` — the wrapper consumers call. One job today: the
  call into dev-config's `check.yml` with `database: false`. The MariaDB
  database jobs land beside it (`#2`–`#6`), each with the composite action that
  runs it, its own suite, and its page under `docs/gates/` — the shape
  dev-config's "Adding a gate" describes.
- `.github/workflows/ci.yml` — this repo's own gate, which is dev-config's
  `check.yml` called directly. It cannot be the wrapper: a commit cannot pin its
  own SHA, so the wrapper's pin is always one commit behind whatever is under
  review.
- `tests/` — what CI cannot see from outside. `wrapper-inputs.test.ts` grades
  the wrapper and the README against the dev-config in `node_modules`, which is
  the commit the workflows call: every declared input reaches the call under its
  own name and is declared with dev-config's own type and default, nothing is
  forwarded that dev-config does not declare, the call carries exactly one
  literal and it is `database: false`, only one job calls that workflow at all,
  what the README tables and what it says is refused cover dev-config's input
  surface exactly, and the four carriers of the pin agree.

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

Once a database job here ships a composite action, this repo takes on
dev-config's release shape too: a commit cannot reference its own SHA, so the
action and the workflow that pins it are two tagged commits.

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
