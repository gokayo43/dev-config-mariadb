import { rm } from "node:fs/promises";
import { join } from "node:path";

import { migrate } from "../.github/actions/db-replay/database.ts";

import { materialise, type Tree } from "./tree.ts";

/**
 * A project with a history, because the upgrade gate reads one.
 *
 * Every other suite here materialises a directory: what those gates grade is a
 * tree and a database. This one grades the relationship between two commits —
 * what a database built from the base ref reaches when this branch's migrations
 * run on top — so a fixture without git in it would be a fixture the gate
 * refuses before it has asked anything.
 *
 * Two commits, and the second is optional: a repository with one commit is the
 * first-commit case, which is a pass with a notice rather than a refusal.
 */

/** A fixture repository: where it is, how to migrate it, and how to make a checkout that cannot answer. */
export interface Repo {
  readonly root: string;
  /** The project's own `db:migrate`, against the database a case hands it. */
  migrate: (url: string) => Promise<void>;
  /** A clone of it with no history, which is what a default GitHub checkout is. */
  shallow: () => Promise<string>;
}

/** What a rev resolves to in a fixture, for the cases that name the base ref themselves. */
export async function headOf(root: string, rev: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", rev], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, status] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (status !== 0) throw new Error(`git rev-parse ${rev} failed in ${root}`);
  return stdout.trim();
}

async function git(root: string, ...args: readonly string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    // An identity of this fixture's own: the box running the suite may have
    // none configured, and `git commit` refuses without one.
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "suite",
      GIT_AUTHOR_EMAIL: "suite@example.invalid",
      GIT_COMMITTER_NAME: "suite",
      GIT_COMMITTER_EMAIL: "suite@example.invalid",
    },
  });
  const [stderr, status] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (status !== 0) throw new Error(`git ${args.join(" ")} failed in ${root}: ${stderr.trim()}`);
}

/** The tree on disk, with whatever the previous commit left that this one does not have removed. */
async function lay(root: string, was: Tree, now: Tree): Promise<void> {
  for (const path of Object.keys(was)) {
    if (!(path in now)) await rm(join(root, path), { force: true });
  }
  for (const [path, contents] of Object.entries(now)) await Bun.write(join(root, path), contents);
}

/**
 * A repository holding `base` as its first commit and `branch` as its second,
 * checked out at the branch.
 *
 * `main` by name because that is what `git init` is asked for rather than what
 * it defaults to: the default is the box's `init.defaultBranch`, and a fixture
 * that reads differently on two developers' machines is one nobody can debug.
 */
export async function committed(base: Tree, branch?: Tree): Promise<Repo> {
  const root = await materialise(base);
  await git(root, "init", "--quiet", "--initial-branch=main");
  await git(root, "add", "--all");
  await git(root, "commit", "--quiet", "-m", "base");

  if (branch !== undefined) {
    await lay(root, base, branch);
    await git(root, "add", "--all");
    await git(root, "commit", "--quiet", "-m", "branch");
  }

  return {
    root,
    migrate: async (url: string) =>
      await migrate(root, url, `the fixture's own db:migrate failed against ${url}`),
    shallow: async () => {
      const into = join(await materialise({}), "shallow");
      // Through the filesystem rather than by copying `.git`: a copy is not
      // shallow, and what this case needs is a checkout that genuinely has no
      // parent commit in it — which is what `actions/checkout` produces by
      // default and what the gate has to refuse rather than read as "nothing to
      // upgrade from".
      await git(root, "clone", "--quiet", "--depth", "1", `file://${root}`, into);
      return into;
    },
  };
}
