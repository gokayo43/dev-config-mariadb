import { allowlistFrom } from "../_lib/allowlist.ts";
import { entry, inputs, publish, required } from "../_lib/annotations.ts";
import { rampGate, SHIPPED } from "./ramp.ts";

await entry(async () => {
  const read = inputs(
    "capacity-script",
    "capacity-path",
    "route-allowlist",
    "health-url",
    "route-log-before",
    "route-log-after",
    "summary-file",
  );

  await publish(
    await rampGate({
      // Fetched and checksum-verified by the step that runs this, which is the
      // only place a pinned binary can be fetched from — see k6.sh.
      k6: required(
        "K6",
        "the step must source k6.sh, which fetches the pinned binary and exports it",
      ),
      script: read["capacity-script"] === "" ? SHIPPED : read["capacity-script"],
      url: read["health-url"],
      paths: read["capacity-path"],
      // The floor is this step's too: it is decided by the two snapshots below,
      // and a route nothing reached is worth naming on the run the failure
      // bound is refusing rather than one round-trip later.
      allowlist: allowlistFrom(read["route-allowlist"], "route-allowlist"),
      before: read["route-log-before"],
      after: read["route-log-after"],
      summary: read["summary-file"],
    }),
    // Where the measurement is published. A ramp with nowhere to publish what
    // it measured is a wiring fault rather than a run, and publish() says so.
    required("GITHUB_STEP_SUMMARY", "the ramp publishes what it measured into the run summary"),
  );
});
