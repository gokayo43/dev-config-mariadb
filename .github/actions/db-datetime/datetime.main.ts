import { allowlistFrom } from "../_lib/allowlist.ts";
import { entry, inputs, publish, required } from "../_lib/annotations.ts";
import { datetimeGate } from "./datetime.ts";

await entry(async () => {
  const read = inputs("datetime-allowlist");

  // The database the calling job declared, out of the environment it owns —
  // the same value the replay step migrated. Taking it as an action input as
  // well would be two values that can disagree about which database was
  // graded, and this step's whole answer is about one catalogue.
  const url = required(
    "DATABASE_URL",
    "this gate reads the catalogue of the database the replay built",
  );

  publish(await datetimeGate(url, allowlistFrom(read["datetime-allowlist"], "datetime-allowlist")));
});
