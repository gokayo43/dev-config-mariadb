#!/usr/bin/env bun
/**
 * k6, as far as the ramp step can tell: a binary it invokes with a script and a
 * `--summary-export` path, which makes some requests and leaves a summary
 * behind.
 *
 * A fake at a true external boundary, which is the one place the testing rules
 * allow one — and it is a fake of the *runner* only. What it leaves behind is a
 * real k6 export captured from a real run (`k6-summary.json`), and the requests
 * it makes are real requests to the real app the case started. The pinned k6
 * itself runs the shipped ramp in `ramp-script.ts`, which is a CI step because
 * it needs the binary.
 *
 * It also asserts what it was invoked with. A step that stopped asking k6 for
 * the percentiles its table prints, or that stopped handing the app over in the
 * environment, would otherwise go green here and publish blanks in CI.
 *
 * The "script" is a JSON plan: `also` is `{ method, path }` requests to make
 * beyond the ones the shipped ramp would make — a path rather than a URL,
 * because the port belongs to the app the case started — `summary` is the
 * capture to leave behind, `stopApp` is a pid file whose process to kill before
 * exiting, and `exit` is what to exit with.
 */
import { isForeign, isList, textAt } from "../.github/actions/_lib/foreign.ts";

function fail(what: string): never {
  process.stderr.write(`fake-k6: ${what}\n`);
  process.exit(9);
}

const args = process.argv.slice(2);
if (args[0] !== "run") fail(`the first argument is ${args[0]}, not run`);
if (!args.includes("--quiet")) fail("no --quiet, so k6 would write a progress bar into the log");
if (!args.some((arg) => arg.startsWith("--summary-trend-stats="))) {
  fail("no --summary-trend-stats, so the export would not carry the percentiles the table prints");
}

const exported = args[args.indexOf("--summary-export") + 1];
const script = args.at(-1);
if (exported === undefined || script === undefined) fail("no --summary-export and script pair");

const health = Bun.env["HEALTH_URL"];
if (health === undefined || health === "") fail("HEALTH_URL is not in the environment");
const origin = new URL(health).origin;

const plan: unknown = await Bun.file(script).json();
if (!isForeign(plan)) fail(`${script} is not a plan`);

// The requests the shipped ramp makes, which is what this stands in for: the
// health route, and every path the caller named, one per line.
const paths = (Bun.env["CAPACITY_PATH"] ?? "")
  .split("\n")
  .map((path) => path.trim())
  .filter((path) => path !== "");
for (const url of [health, ...paths.map((path) => origin + path)]) {
  await fetch(url);
}

const also = plan["also"];
if (isList(also)) {
  for (const one of also) {
    const path = textAt(one, "path");
    if (path !== undefined) await fetch(origin + path, { method: textAt(one, "method") ?? "GET" });
  }
}

const summary = textAt(plan, "summary");
if (summary !== undefined) await Bun.write(exported, Bun.file(summary));

// The app taken down mid-ramp, which is what the held snapshot failure is for.
const stopApp = textAt(plan, "stopApp");
if (stopApp !== undefined) {
  process.kill(Number((await Bun.file(stopApp).text()).trim()), "SIGKILL");
}

const exit = plan["exit"];
process.exit(typeof exit === "number" ? exit : 0);
