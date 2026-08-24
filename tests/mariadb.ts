import { afterEach } from "bun:test";

import { SQL } from "bun";

import { isList } from "../.github/actions/_lib/foreign.ts";

import { dbImage, root } from "./workflow.ts";

/**
 * A real MariaDB for the suite that drives the replay gate, because what that
 * gate asserts is what a database ends up holding: a second replay that changed
 * the schema is a fact about one server's catalogue, and nothing in-process can
 * report it. The dump the verdict rests on is a real `mariadb-dump` against a
 * real socket as well.
 */

/**
 * The image the shipped job runs its server from and takes its dump client
 * from. Read out of the workflow rather than written here, and handed to the
 * gate under test: a suite grading it against a server the job does not run
 * would be proving it about nothing.
 */
export const IMAGE = await dbImage();

/** What the container answers to, which is a dummy for a server that lives for one suite run. */
const PASSWORD = "mariadb";

/** The same server, pointing at another of its databases. */
function beside(url: string, database: string): string {
  const swapped = new URL(url);
  swapped.pathname = `/${database}`;
  return swapped.href;
}

/**
 * One container for this worktree, named after it.
 *
 * Named rather than random for the reason the gates in this house derive a
 * scratch database's name: a run killed outright leaves the container behind,
 * and a name the next run derives again is one it reclaims with `docker rm -f`
 * before it creates. A random name would leave one server per killed run
 * running forever.
 *
 * The worktree is what distinguishes it, so two checkouts under review at once
 * — and any neighbour's containers on the same daemon — are never each other's.
 */
const CONTAINER = `dev-config-mariadb-suite-${new Bun.CryptoHasher("sha256").update(root).digest("hex").slice(0, 16)}`;

async function docker(...args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (status !== 0) throw new Error(`docker ${args.join(" ")}: ${stderr.trim()}`);
  return stdout.trim();
}

/**
 * The server, up and answering. Polled with a query rather than with
 * `mariadb-admin ping`: the image's entrypoint runs a temporary server while it
 * initialises, so a ping is answered by something that is about to be shut down
 * and restarted, and a client that connected to it is dropped mid-statement.
 */
async function started(): Promise<string> {
  await docker("rm", "--force", CONTAINER);
  await docker(
    "run",
    "--detach",
    "--name",
    CONTAINER,
    // Loopback only. This is a database with a known password on a machine that
    // serves live customers.
    "--publish",
    "127.0.0.1::3306",
    "--env",
    `MARIADB_ROOT_PASSWORD=${PASSWORD}`,
    IMAGE,
  );
  const published = await docker("port", CONTAINER, "3306/tcp");
  const port = published.split("\n")[0]?.split(":").at(-1);
  if (port === undefined) throw new Error(`${CONTAINER} published no port: ${published}`);

  const url = beside(`mysql://root:${PASSWORD}@127.0.0.1:${port}/`, "mysql");
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const db = new SQL(url);
      await db.unsafe("select 1");
      await db.close();
      return url;
    } catch (refused) {
      // Polled against the container as well as against the query. The name is
      // derived from the checkout, so a SECOND run of this suite in the SAME
      // checkout reclaims this container out from under the first — and without
      // this check the first spends the whole deadline failing to connect to a
      // server that no longer exists, which reads as a hang rather than as the
      // collision it is. (Two checkouts are genuinely independent; that is what
      // the name is derived from the worktree for.)
      if (!(await running())) {
        throw new Error(
          `${CONTAINER} is gone while this run was still waiting for it — another run of this suite in this same checkout reclaimed the name, or the server died on boot. Run the suite once per checkout at a time, or use a second worktree.`,
          { cause: refused },
        );
      }
      if (Date.now() > deadline) {
        throw new Error(`${CONTAINER} never answered a query`, { cause: refused });
      }
      await Bun.sleep(500);
    }
  }
}

/** Whether the container this run started is still there to be waited for. */
async function running(): Promise<boolean> {
  const proc = Bun.spawn(["docker", "inspect", "--format", "{{.State.Running}}", CONTAINER], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stdout, status] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return status === 0 && stdout.trim() === "true";
}

/**
 * The server, started once per run and shared by every file that asks for one.
 *
 * Lazy, and that is the whole of why it is a function rather than a
 * top-level `await` on a `const`. Two things depend on it:
 *
 * **The teardown has to be registered outside any file.** `bun test` runs every
 * file in one process, and a hook registered at the top level of an imported
 * module attaches to whichever file imported it FIRST — so an `afterAll` here
 * would tear the server down after that file's cases and leave every later file
 * connecting to nothing, under a `Connection closed` naming neither this module
 * nor the cause. `tests/preload.ts` registers it at the root scope instead,
 * where it runs after all of them; for that, importing this module must not
 * start anything.
 *
 * **A run that needs no database should start none.** `bun test
 * tests/annotations.test.ts` touches no server, and under a top-level start it
 * paid for one anyway.
 */
export async function server(): Promise<string> {
  up ??= started();
  return await up;
}

let up: Promise<string> | undefined;

/**
 * The end of the run, called from the root scope. Nothing to do if no case ever
 * asked for a server — and `started()` reclaims the name before it creates,
 * so a run killed hard enough to skip this leaves nothing the next one trips
 * on.
 */
export async function stop(): Promise<void> {
  if (up === undefined) return;
  up = undefined;
  await docker("rm", "--force", CONTAINER);
}

const made: string[] = [];

afterEach(async () => {
  if (made.length === 0) return;
  const db = new SQL(await server());
  for (const name of made.splice(0)) await db.unsafe(`drop database if exists \`${name}\``);
  await db.close();
});

/**
 * How many databases this run has asked for. Counted rather than read off
 * `made`, whose length is only true until the first `await` below: two cases
 * running at once would both see the same length, ask for the same name, and
 * the second would meet a database rather than make one.
 */
let asked = 0;

/** An empty database of this case's own, and its URL. */
export async function emptyDatabase(): Promise<string> {
  const name = `replay_${process.pid}_${asked++}`;
  const url = await server();
  const db = new SQL(url);
  await db.unsafe(`drop database if exists \`${name}\``);
  await db.unsafe(`create database \`${name}\``);
  await db.close();
  made.push(name);
  return beside(url, name);
}

/** What a case has to be able to ask the server directly, where the gate's own answer is what is under test. */
export async function query(url: string, sql: string): Promise<readonly unknown[]> {
  const db = new SQL(url);
  try {
    const answered: unknown = await db.unsafe(sql);
    return isList(answered) ? answered : [];
  } finally {
    await db.close();
  }
}
