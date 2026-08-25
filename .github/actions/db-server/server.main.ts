import { entry, inputs, publish, required } from "../_lib/annotations.ts";
import { startServer } from "./server.ts";

/**
 * One server per job, and the name says which job by deriving from the
 * workspace the runner gave it.
 *
 * A constant would do on a GitHub-hosted runner, where the machine is the job.
 * It would not on a self-hosted one: the name is reclaimed with `docker rm
 * --force` before it is created, so two jobs running at once against one docker
 * daemon under one constant name would each kill the other's server mid-gate.
 * Two runners on one machine are required to have their own `_work` roots — one
 * cannot share another's — so the workspace is a key that separates them, while
 * staying the same across re-runs of one job, which is what the reclaim needs.
 * Two jobs that did share a workspace would still collide, which is the state
 * this replaces rather than a hole it opens.
 *
 * From `github.workspace` through the action rather than from the environment:
 * an expression context is not something a step of the graded repo can write,
 * and `$GITHUB_WORKSPACE` is.
 */
function containerFor(workspace: string): string {
  return `db-gate-server-${new Bun.CryptoHasher("sha256").update(workspace).digest("hex").slice(0, 16)}`;
}

/**
 * How long the server has to come up, and it is a bound rather than a guess.
 * Measured on the pins this repo certifies, image already local: 10s for
 * MariaDB 11.4 and 25s for MySQL 8.0 from `docker run` to the first query
 * answered. A runner pays an image pull on top of that, and the job that calls
 * this allows itself fifteen minutes for everything after it — so two minutes
 * is room for a cold pull and a slow box without being a bound that lets a
 * wedged server eat the job.
 */
const WITHIN = 120_000;

await entry(async () => {
  const read = inputs("database-image", "workspace");

  // The database the calling job declared, mapped into this step by the action
  // from the value that job read before the graded repo ran — action.yml says
  // why it is an input there rather than whatever the environment now holds.
  const url = required(
    "DATABASE_URL",
    "the calling job declares the database every gate after this step uses",
  );

  await publish(
    await startServer({
      image: read["database-image"],
      url,
      as: containerFor(read["workspace"]),
      within: WITHIN,
    }),
  );
});
