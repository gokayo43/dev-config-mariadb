import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { killGroup, shellGroup } from "../.github/actions/db-serving/group.ts";

import { root } from "./workflow.ts";

/**
 * A `*.main.ts` run the way GitHub runs it: as a process, under a wall clock,
 * with nothing of this suite's inside it.
 *
 * Every other file here drives a gate's *function*, in-process, where the one
 * thing a step must do is invisible — **exit**. A gate that publishes a perfect
 * verdict and then holds the event loop open is a step that hangs until the
 * job's timeout, and no assertion about a returned `Verdict` can see it. The
 * entry points are also the only place `entry`'s `process.exit(1)` and
 * `publish`'s `process.exitCode` are real.
 */

/** Where the entry points are, since knip's own entry glob is the same statement. */
export const ACTIONS = join(root, ".github/actions");

/** Every entry point in the tree, by `<action>/<file>` — read rather than listed, so a new one cannot be forgotten. */
export async function entryPoints(): Promise<string[]> {
  const found: string[] = [];
  for (const action of await readdir(ACTIONS, { withFileTypes: true })) {
    if (!action.isDirectory()) continue;
    for (const file of await readdir(join(ACTIONS, action.name))) {
      if (file.endsWith(".main.ts")) found.push(`${action.name}/${file}`);
    }
  }
  return found.toSorted();
}

export interface Ran {
  readonly status: number;
  readonly output: string;
  /** Whether the bound fired, which is the failure this lane exists to catch. */
  readonly hung: boolean;
  readonly took: number;
}

/**
 * The entry point, spawned under `setsid` so that a run which leaves something
 * behind is killed with everything it started rather than leaking a server per
 * case into the machine this suite runs on.
 *
 * The bound is the assertion's whole subject, so it is generous: any of these
 * finishing takes under a second, and a case that reaches ten is not slow, it
 * is stuck.
 */
export async function ranEntryPoint(
  main: string,
  environment: Readonly<Record<string, string>>,
  seconds = 10,
): Promise<Ran> {
  const started = Date.now();
  const proc = Bun.spawn(shellGroup(`exec "${process.execPath}" ${join(ACTIONS, main)}`), {
    // The action's own directory, which is where the shipped step runs it from.
    cwd: join(ACTIONS, main, ".."),
    env: { ...process.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });

  const collected = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const HUNG = Symbol("the bound fired");
  let bound: ReturnType<typeof setTimeout> | undefined;
  const finished = await Promise.race([
    collected,
    new Promise<typeof HUNG>((resolve) => {
      bound = setTimeout(() => resolve(HUNG), seconds * 1000);
    }),
  ]);
  clearTimeout(bound);

  if (finished === HUNG) {
    killGroup(proc.pid);
    proc.unref();
    return { status: -1, output: "", hung: true, took: Date.now() - started };
  }
  const [out, err, status] = finished;
  return { status, output: out + err, hung: false, took: Date.now() - started };
}
