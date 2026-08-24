# Vocabulary

The words this repo's workflows, tests and issues use, and what each one means
here. dev-config's own `CONTEXT.md` holds the vocabulary of the gates
themselves — a gate, a problem, an exemption, an allowlist entry — and this file
never restates it.

**dev-config** — `gokayo43/dev-config`, the fleet's tooling policy: the configs
every Bun repo inherits and the `check.yml` every repo calls. Referred to as
"upstream" nowhere in the tree; it is a repo with a name.

**The wrapper** — `.github/workflows/check.yml` here. What a consuming repo
calls in place of dev-config's `check.yml`.

**The static gate** — everything dev-config's `check.yml` runs with
`database: false`. The wrapper hands it on unchanged, which is the whole of what
"unchanged" means in this repo: the same workflow, at a pinned commit, over the
consumer's own tree.

**A database job** — a job of this repo's own that grades a MariaDB the
consuming repo's migrations built. dev-config's job of that name is Postgres,
and the two never run in one call.

**Pass-through** — an input the wrapper declares only in order to hand it to
dev-config's `check.yml` under the same name. A pass-through has no behaviour
here; an input that did would not be one.

**A consumer** — a repo whose `ci.yml` calls the wrapper. There are two, both
named in `README.md`, and both are older than the fleet's Postgres decision.

**The pin** — the 40-character commit SHA a `uses:` names, with the release tag
as a trailing comment. The pin is the contract; the tag is the label. Nothing
here is reached by a tag or a branch.
