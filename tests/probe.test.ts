import { expect, test } from "bun:test";
import { join } from "node:path";

import {
  APP_URL,
  DEFAULT_SECONDS,
  probeGate,
  secondsFrom,
} from "../.github/actions/db-serving/probe.ts";

import { gone, pidIn } from "./app.ts";
import { materialise } from "./tree.ts";

/**
 * The probe contract, which is dev-config's and is not this repo's to soften:
 * **stdout is the verdict.** Every case below is about that sentence or about
 * the bound around it, and the commands are real shell run as real processes,
 * because what the contract is about is what a program does rather than what a
 * function returns.
 *
 * The app is a URL rather than a server here. Nothing this step does looks at
 * what is on the other end of it — the probe is the only thing that talks to
 * the app, and the probe is the repo's.
 */

const APP = "http://127.0.0.1:65535/health";

async function probe(command: string, timeout = "30"): Promise<ReturnType<typeof probeGate>> {
  return probeGate({ root: await materialise({}), command, url: APP, timeout });
}

test("every line on stdout is a problem, whatever the command exits", async () => {
  // The half a probe gets wrong: a runner that collects failures and reports
  // them at the end exits 0 having printed exactly what is broken. A gate
  // reading the status first is silent about an app that said out loud what was
  // wrong with it.
  const verdict = await probe("echo 'GET /presets answered 500'; echo 'slug is null on 3 rows'");

  expect(verdict.problems).toEqual(["GET /presets answered 500", "slug is null on 3 rows"]);
  expect(verdict.note).toContain("reported 2 problems");
});

test("a command that fails having said nothing is refused in the gate's own words", async () => {
  const verdict = await probe(">&2 echo 'assertion failed somewhere'; exit 7");

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain("exited 7 and wrote nothing to stdout");
  expect(verdict.problems[0]).toContain("names each invariant it broke on a line of its own");
  // A red step with an empty explanation is the one thing no gate here may
  // produce, so what it did write is on the log under that annotation.
  expect(verdict.log).toContain("assertion failed somewhere");
});

test("a probe that says nothing and exits 0 is a probe that found nothing", async () => {
  const verdict = await probe("true");

  expect(verdict.problems).toEqual([]);
  expect(verdict.note).toContain("came back clean");
});

test("the app reaches the command under the one name every step here uses", async () => {
  const verdict = await probe(`echo "$${APP_URL}"`);

  expect(verdict.problems).toEqual([APP]);
});

test("a bound with no command under it is refused rather than ignored", async () => {
  const verdict = await probe("   ", "45");

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain(
    "probe-timeout is set to 45s and probe-command is only whitespace",
  );
});

test("a probe that is only whitespace is refused without inventing a bound nobody wrote", async () => {
  // `probe-command: |` with a blank body selects this step, and the bound is
  // unset — so a diagnostic written off the parsed number would send its reader
  // to a 120s default they never chose, in an input they never touched.
  const verdict = await probe("  \n  ", "");

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain("probe-command is only whitespace");
  expect(verdict.problems[0]).not.toContain("probe-timeout");
  expect(verdict.problems[0]).not.toContain("120");
});

test("the bound takes everything the probe started, not only the shell", async () => {
  // bash only *execs* a command that is one simple command. This one is a
  // background job, so the shell forks — and the child holds the write end of
  // the stdout pipe this step reads. Killing the shell alone leaves it running
  // and the read never sees EOF.
  const root = await materialise({});
  const child = join(root, "child.pid");
  const started = Date.now();

  const verdict = await probeGate({
    root,
    command: `sleep 60 & echo $! > ${child}; wait`,
    url: APP,
    timeout: "1",
  });
  const took = Date.now() - started;

  expect(verdict.problems).toHaveLength(1);
  expect(verdict.problems[0]).toContain("was still running after 1s and was killed");
  expect(verdict.problems[0]).toContain("along with everything it had started");
  // The child, which is what the group kill is for.
  expect(await gone(await pidIn(child))).toBe(true);
  // And it settled without spending the salvage grace, which is what says the
  // kill reached the process holding the pipe rather than the shell above it.
  expect(took).toBeLessThan(4000);
});

test("a probe that colours its output is read as text rather than as escape codes", async () => {
  const verdict = await probe("printf '\\033[31mGET /things answered 500\\033[0m\\n'");

  expect(verdict.problems).toEqual(["GET /things answered 500"]);
});

test("a probe that dumps a log is capped, and says how much it wrote", async () => {
  const verdict = await probe("seq 1 60");

  expect(verdict.problems).toHaveLength(51);
  expect(verdict.problems[0]).toBe("1");
  expect(verdict.problems.at(-1)).toContain("wrote 60 lines to stdout");
  expect(verdict.problems.at(-1)).toContain("the other 10 are on the log");
  // The count above the annotations and the annotations themselves are one run.
  expect(verdict.note).toContain("reported 51 problems");
});

test("the bound is refused rather than defaulted when nobody can read it", () => {
  expect(secondsFrom("")).toBe(DEFAULT_SECONDS);
  expect(secondsFrom("30")).toBe(30);
  expect(() => secondsFrom("0")).toThrow("greater than zero");
  expect(() => secondsFrom("-5")).toThrow("greater than zero");
  expect(() => secondsFrom("2m")).toThrow("greater than zero");
  // A bound at or above 2147484 seconds overflows the timer it is stored in and
  // kills the probe the instant it starts, under a diagnostic saying it ran too
  // long. Refused at an hour, which is a number a person can reason about.
  expect(() => secondsFrom("7200")).toThrow("longer than the 3600s this takes");
});
