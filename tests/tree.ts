import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A project as a map of path to contents. Absent means the file is not there. */
export type Tree = Record<string, string>;

const live: string[] = [];

// Registered here rather than copied into every suite: a new case cannot forget
// the cleanup, and a forgotten one leaves a project per test in the temp
// directory.
afterEach(async () => {
  await Promise.all(
    live.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

/**
 * A tree on disk, which is what the gate reads: it runs `bun run db:migrate` in
 * a directory and the migrator resolves its lineage relative to that.
 *
 * A fresh directory per case rather than a derived one. Nothing the gate builds
 * is named after this root — it replays into the database the caller declared —
 * so there is no name a killed run would leave behind for the next to reclaim,
 * and two cases sharing a root would be two migrators writing one lineage.
 */
export async function materialise(tree: Tree): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "db-replay-"));
  live.push(root);
  for (const [path, contents] of Object.entries(tree)) {
    await Bun.write(join(root, path), contents);
  }
  return root;
}

/** A copy of `tree` with one file removed — one defect per case. */
export function without(tree: Tree, path: string): Tree {
  return Object.fromEntries(Object.entries(tree).filter(([each]) => each !== path));
}
