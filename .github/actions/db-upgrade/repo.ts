/**
 * What this gate reads out of git: the commit this tree is compared against,
 * the files a tree holds, and the one way of running git that has an answer for
 * "no".
 *
 * **Checked-in copies of dev-config's `_lib/gate.ts` at the pinned SHA**, not
 * independent work: `git`, `baseRevision` and `repoFiles` are theirs, with the
 * deltas named below. An action runs from a checkout with no `node_modules`
 * above it and `.github/` sits outside dev-config's `files` allowlist, so there
 * is no import that reaches them — CLAUDE.md's "It only adds" rule carries the
 * carve-out, and dev-config#69 is where ending it is argued. A bug fixed there
 * is a bug still here until somebody carries it over.
 *
 * The one delta running through all three: a problem here is a string rather
 * than their `Problem`, because every problem this repo's gates raise is about
 * a database rather than about a line of the tree — `_lib/annotations.ts` says
 * why an annotation that pointed at nothing would be dropped by GitHub in
 * silence.
 */

/** A git invocation's exit status and what it wrote. */
export interface Ran {
  readonly ok: boolean;
  readonly stdout: string;
}

/**
 * git, for every read this gate makes of a tree or a history. Failure comes
 * back rather than thrown, because to most of what is asked here "no" is the
 * answer — a path that is not tracked, a lineage the base ref did not carry —
 * and the callers that cannot go on without an answer say so themselves.
 *
 * dev-config's, verbatim.
 */
export async function git(cwd: string, args: readonly string[]): Promise<Ran> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  const stdout = await new Response(proc.stdout).text();
  return { ok: (await proc.exited) === 0, stdout };
}

/** What the run knows about where it came from, which is all a base ref can be derived from. */
export interface Event {
  /** `github.base_ref`: the branch a pull request targets, empty off one. */
  readonly baseRef: string;
  /** `github.event.before`: the tip the branch had before this push, empty or all-zero otherwise. */
  readonly before: string;
}

/**
 * The commit this tree is compared against, or why this checkout cannot name
 * one.
 *
 * `rev` undefined is a first commit: there is no earlier tree, and the gate
 * passes with a notice. `refused` is a checkout that cannot answer — a shallow
 * clone, a base branch that is not in it — which is a broken run rather than a
 * fact about the repo, and reading it as "nothing to compare against" is
 * reading a misconfiguration as a verdict.
 */
export type Base = { readonly rev: string | undefined } | { readonly refused: string };

/**
 * dev-config's `baseRevision`, with their `missing` field dropped: it exists so
 * that their repo contract and their database gate can scope one refusal two
 * ways, and this gate is the only caller here. What each branch decides is
 * theirs unchanged — including that a shallow checkout is refused rather than
 * read as having no history, which is the hole a gate passing on an empty
 * answer would be.
 */
export async function baseRevision(root: string, event: Event, why: string): Promise<Base> {
  // Also what establishes that this is a repository at all: outside one the
  // command fails, and reading its empty output as "not shallow" would let
  // every git question below answer "no" and the whole gate pass.
  const shallow = await git(root, ["rev-parse", "--is-shallow-repository"]);
  if (!shallow.ok) {
    return {
      refused: `could not establish whether this checkout has history: \`git rev-parse --is-shallow-repository\` failed in ${root} — ${why}, and a checkout it cannot read is refused rather than read as having none`,
    };
  }
  if (shallow.stdout.trim() === "true") {
    return {
      refused: `the checkout is shallow, so the base ref is not in it — ${why}; check out with fetch-depth: 0`,
    };
  }

  if (event.baseRef !== "") {
    const base = `refs/remotes/origin/${event.baseRef}`;
    const merged = await git(root, ["merge-base", base, "HEAD"]);
    if (!merged.ok) {
      return {
        refused: `${base} is not in this checkout, so there is nothing to take the merge base with — ${why}; check out with fetch-depth: 0`,
      };
    }
    return { rev: merged.stdout.trim() };
  }

  if (event.before !== "" && (await git(root, ["cat-file", "-e", `${event.before}^{commit}`])).ok) {
    return { rev: event.before };
  }
  const parent = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD^"]);
  return { rev: parent.ok ? parent.stdout.trim() : undefined };
}

/**
 * Never a repo's own code, whatever its .gitignore says. `--others` lists
 * anything git would keep, so a repo whose .gitignore forgets node_modules
 * hands every gate tens of thousands of third-party files.
 */
const NEVER = ":(exclude,glob)**/node_modules/**";

/**
 * The files a gate looks at: what is on disk, minus what .gitignore describes.
 * The listing is git's rather than a walk of the filesystem, and the existence
 * filter is the other half of that — `--cached` still lists a file deleted from
 * the worktree.
 *
 * dev-config's, verbatim.
 */
export async function repoFiles(root: string, pathspecs: readonly string[]): Promise<string[]> {
  const listing = await git(root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...pathspecs,
    NEVER,
  ]);
  if (!listing.ok) throw new Error(`git ls-files failed in ${root}`);
  const listed = listing.stdout.split("\0").filter((path) => path !== "");
  const found = await Promise.all(
    listed.map(async (path) => ((await Bun.file(`${root}/${path}`).exists()) ? path : undefined)),
  );
  return found.filter((path) => path !== undefined);
}
