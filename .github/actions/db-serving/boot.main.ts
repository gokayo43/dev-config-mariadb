import { entry, inputs, publish } from "../_lib/annotations.ts";
import { BOOT_SECONDS, bootGate, healthUrlFrom, startCommandFrom } from "./boot.ts";

await entry(async () => {
  const read = inputs("start-command", "health-url", "app-log");

  await publish(
    await bootGate({
      // The action ran this from the project it was pointed at, and the app is
      // started the way that project would start it.
      root: process.cwd(),
      command: startCommandFrom(read["start-command"]),
      // Refused here, before anything is started: every step after this one is
      // aimed at this URL, and each would otherwise refuse it in a vocabulary
      // of its own.
      url: healthUrlFrom(read["health-url"]),
      log: read["app-log"],
      // The module's own number rather than an input. Nothing a caller could
      // say about how long its app takes to start is a fact this gate wants to
      // take on trust — boot.ts carries the bound and the argument for it.
      seconds: BOOT_SECONDS,
    }),
  );
});
