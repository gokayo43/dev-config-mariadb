import { entry, inputs, publish, required } from "../_lib/annotations.ts";
import { replayGate } from "./replay.ts";

await entry(async () => {
  const read = inputs("db-image", "from-empty", "replayed");

  // The database the calling job declared, out of the environment it owns.
  // Taking it as an action input as well would be two values that can disagree
  // about which database was replayed into, and this is the step that migrates
  // it first — so it is the one that says what the caller owes.
  const url = required("DATABASE_URL", "the calling job must set it for the database it declared");

  await publish(
    await replayGate({
      // The action ran this from the project it was pointed at, and the
      // migrator is read relative to it.
      root: process.cwd(),
      url,
      image: read["db-image"],
      fromEmpty: read["from-empty"],
      replayed: read["replayed"],
    }),
  );
});
