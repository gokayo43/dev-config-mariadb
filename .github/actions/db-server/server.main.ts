import { entry, inputs, publish, required } from "../_lib/annotations.ts";
import { startServer } from "./server.ts";

/**
 * One server per job, so its name is a constant rather than something derived:
 * two of these steps in one job would be one server, which is what the name
 * says. It is reclaimed before it is created, which is what a runner that is not
 * thrown away after the job — a self-hosted one — needs from it.
 */
const CONTAINER = "db-gate-server";

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
  const read = inputs("database-image");

  // The database the calling job declared, mapped into this step by the action
  // from the value that job read before the graded repo ran — action.yml says
  // why it is an input there rather than whatever the environment now holds.
  const url = required(
    "DATABASE_URL",
    "the calling job declares the database every gate after this step uses",
  );

  await publish(
    await startServer({ image: read["database-image"], url, as: CONTAINER, within: WITHIN }),
  );
});
