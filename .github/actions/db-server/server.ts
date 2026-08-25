import type { Verdict } from "../_lib/annotations.ts";
import { databaseIn, rowsFrom, textIn } from "../db-replay/database.ts";

/**
 * The server every later step of the database job grades, started from the image
 * the calling repo pinned and left running for them.
 *
 * Not a gate: it decides nothing about the repo under grade. What it refuses is
 * a wiring fault — an image that was never passed, a URL no server this step
 * starts could be reached on, an image that comes up and then dies — each of
 * which would otherwise be spent as the whole of a job's timeout by whichever
 * gate connected first.
 *
 * The two server products this repo serves are one image reference to
 * everything here: which product a consumer runs is their pinned digest, and
 * nothing below reads a product name out of it. docs/gates/db-server.md is the
 * page.
 */

/** How often the poll below asks, which is a compromise between a fast start and a busy log. */
const ASK_EVERY = 500;

/** Where and from what a server is started, and how long it has to answer. */
export interface Server {
  /** The image, pinned by digest, that the calling repo declared. */
  readonly image: string;
  /** The database the gates then use, which is also where this reads the port, the account and the database name. */
  readonly url: string;
  /** The container to run it as, reclaimed before it is created. */
  readonly as: string;
  /** How long the server has, in milliseconds, before this step says it never came up. */
  readonly within: number;
}

/** One docker command, and everything it said. */
async function docker(
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<{ readonly status: number; readonly stdout: string; readonly stderr: string }> {
  const proc = Bun.spawn(["docker", ...args], {
    env: { ...process.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, stdout, stderr };
}

/**
 * What the account, the port and the database name are read from, and the whole
 * of what this step is allowed to be asked for.
 *
 * A composite action maps a missing input to the empty string, so `required:
 * true` in action.yml is a promise nothing enforces at runtime; and the two
 * facts below are not requirements this step could satisfy by trying harder.
 * The image's entrypoint initialises exactly one account from the password it is
 * given, and a container's port is published on the loopback address of the
 * machine the job runs on — so a URL naming another user, or another host, names
 * a server this step is not the one starting. check.yml passes neither; a caller
 * running the action directly is who these are for.
 */
function wiring({ image, url }: Server): string[] {
  if (image.trim() === "") {
    return [
      "the database-image input is empty, and it names the server this job grades — the calling job has to pass the image its consumer pinned by digest.",
    ];
  }
  const server = new URL(url);
  const problems: string[] = [];
  if (server.hostname !== "127.0.0.1") {
    problems.push(
      `database-url names ${server.hostname}, and this step publishes the server it starts on 127.0.0.1 — a host it does not publish on is a server somebody else is running.`,
    );
  }
  if (decodeURIComponent(server.username) !== "root") {
    problems.push(
      `database-url names the account ${decodeURIComponent(server.username)}, and this step initialises the server's root account from that URL's password — an account the image never created cannot answer.`,
    );
  }
  return problems;
}

/** The server as it says who it is, which is the one line a green step leaves behind. */
async function versionOf(url: string): Promise<string> {
  const [row] = await rowsFrom(url, "select version() as version", []);
  if (row === undefined) throw new Error("select version() answered no row");
  return textIn(row, "version", "the server's own answer to select version()");
}

/** Whether the container this step created is still there to be waited for. */
async function running(name: string): Promise<boolean> {
  const asked = await docker(["inspect", "--format", "{{.State.Running}}", name]);
  return asked.status === 0 && asked.stdout.trim() === "true";
}

/** What the server itself wrote, which is where an image that came up and died says why. */
async function logsOf(name: string): Promise<string> {
  const asked = await docker(["logs", name]);
  return asked.stdout + asked.stderr;
}

/**
 * The server, up and answering a query.
 *
 * A query rather than a ping through the image's own client, and that is what
 * makes this step one step rather than two shapes of one: MariaDB 11.4 ships
 * `mariadb-admin` with no `mysqladmin`, a MySQL 8 image ships only
 * `mysqladmin`, and neither name is a name this step has to know if what it
 * asks for is a row.
 *
 * It also asks the thing worth asking. Both images run a temporary server with
 * networking off while they initialise, so a port that answers is a server past
 * that — and a query proves the account and the database the gates were handed
 * are the ones this container came up with, which a ping does not.
 */
export async function startServer(asked: Server): Promise<Verdict> {
  const problems = wiring(asked);
  if (problems.length > 0) return { problems };

  const { image, url, as, within } = asked;
  const server = new URL(url);
  const port = server.port === "" ? "3306" : server.port;
  // Reclaimed rather than assumed absent: a run killed outright leaves the
  // container behind, and the next run derives the same name.
  await docker(["rm", "--force", as]);
  // The password goes through the environment rather than the argument list:
  // `--env NAME` with no value hands over the one this process holds, so it
  // never reaches the command line the runner logs or another process can read.
  //
  // MYSQL_ROOT_PASSWORD and MYSQL_DATABASE rather than the MARIADB_ spellings,
  // because those two names are the ones BOTH images read — probed on the pins
  // this repo certifies: the MariaDB image keeps the MYSQL_ names for
  // compatibility, and no MySQL image has ever had the MARIADB_ ones.
  const started = await docker(
    [
      "run",
      "--detach",
      "--name",
      as,
      "--publish",
      `127.0.0.1:${port}:3306`,
      "--env",
      "MYSQL_ROOT_PASSWORD",
      "--env",
      "MYSQL_DATABASE",
      image,
    ],
    {
      MYSQL_ROOT_PASSWORD: decodeURIComponent(server.password),
      MYSQL_DATABASE: databaseIn(url),
    },
  );
  if (started.status !== 0) {
    return {
      problems: [
        `docker could not start ${image} — \`docker run\` exited ${started.status}: ${started.stderr.trim()}`,
      ],
    };
  }

  const deadline = Date.now() + within;
  for (;;) {
    try {
      const version = await versionOf(url);
      return { note: `server: ${image} came up and answered as ${version}`, problems: [] };
    } catch (refused) {
      const why = refused instanceof Error ? refused.message : String(refused);
      if (!(await running(as))) {
        return {
          log: await logsOf(as),
          problems: [
            `${image} started and then stopped — the server's own output is above. The image the calling repo pinned has to be one that runs a MySQL-family server on 3306 with the account this job's database-url names.`,
          ],
        };
      }
      if (Date.now() > deadline) {
        return {
          log: await logsOf(as),
          problems: [
            `${image} never answered a query within ${Math.round(within / 1000)}s, and the last attempt said: ${why}. The server's own output is above; every later step of this job connects the same way.`,
          ],
        };
      }
      await Bun.sleep(ASK_EVERY);
    }
  }
}
