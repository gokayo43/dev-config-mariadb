import { expect, test } from "bun:test";

import { type Foreign, isForeign, isList, mapAt, textAt } from "../.github/actions/_lib/foreign.ts";

import { root, WRAPPER, wrapperDocument } from "./workflow.ts";

/**
 * The wiring the gates themselves cannot see: which steps the shipped job runs,
 * what the app is given, and whether the evidence every one of them leaves
 * behind is actually uploaded.
 *
 * Each of these is a way for a green run to mean nothing. An app booted without
 * `ROUTE_LOG` serves no instrument, so the floor grades a payload that never
 * comes; a file written into the runner and left out of the upload is evidence
 * deleted with the runner; a ramp step that stopped sourcing the pinned fetch
 * runs whatever k6 the machine happens to have.
 */

/** Where a step leaves a file for the job to upload afterwards. */
const IN_RUNNER_TEMP = /\$\{\{\s*runner\.temp\s*\}\}\/([\w.-]+)/u;

async function action(name: string): Promise<Foreign> {
  const parsed: unknown = Bun.YAML.parse(
    await Bun.file(`${root}/.github/actions/${name}/action.yml`).text(),
  );
  if (!isForeign(parsed)) throw new Error(`${name}/action.yml did not parse as an action`);
  return parsed;
}

function stepsOf(document: Foreign): Foreign[] {
  const steps = mapAt(document, "runs")["steps"];
  return (isList(steps) ? steps : []).filter((step) => isForeign(step));
}

/**
 * Every file under the runner's temp directory the action names, by name and
 * once each: two steps naming one file — the snapshots, written by the ramp and
 * read by the floor — are one file to upload.
 */
function runnerFiles(document: Foreign): string[] {
  return [
    ...new Set(
      stepsOf(document).flatMap((step) =>
        Object.values(mapAt(step, "env")).flatMap((value) => {
          const found = typeof value === "string" ? IN_RUNNER_TEMP.exec(value) : null;
          return found?.[1] === undefined ? [] : [found[1]];
        }),
      ),
    ),
  ];
}

const wrapper = await wrapperDocument();
const serving = await action("db-serving");
const replay = await action("db-replay");

/** The steps of the one job that builds a database and runs an app against it. */
function jobSteps(): Foreign[] {
  const steps = mapAt(mapAt(wrapper, "jobs"), "replay")["steps"];
  return (isList(steps) ? steps : []).filter((step) => isForeign(step));
}

function stepUsing(what: string): Foreign {
  const found = jobSteps().find((step) => (textAt(step, "uses") ?? "").includes(what));
  if (found === undefined) throw new Error(`${WRAPPER}'s database job has no step using ${what}`);
  return found;
}

test("every file the gates leave in the runner is in the artifact the job uploads", async () => {
  const upload = stepUsing("actions/upload-artifact");
  const path = textAt(mapAt(upload, "with"), "path") ?? "";

  const written = [...runnerFiles(serving), ...runnerFiles(replay)];
  // The two schemas the replay compared, the app's own output, the k6 summary
  // and both route-log snapshots: six files, and the whole reason the upload
  // belongs to the job rather than to either action.
  expect(written).toHaveLength(6);
  expect(written.filter((file) => !path.includes(file))).toEqual([]);

  // The run that failed on the way to a number is exactly the run whose partial
  // evidence is worth having; a cancelled one has nothing to say.
  expect(textAt(upload, "if")).toContain("!cancelled()");
  expect(textAt(mapAt(upload, "with"), "if-no-files-found")).toBe("ignore");
});

test("the app is booted with the instrument the coverage floor reads", () => {
  const boot = stepsOf(serving)[0];
  expect(textAt(boot, "name")).toBe("Boot against that database");
  // Set only here: an instrument rather than a surface, and no deployment sets
  // it. Without it the app serves no route log and the floor grades nothing.
  expect(textAt(mapAt(boot, "env"), "ROUTE_LOG")).toBe("true");
});

test("the probe step runs when either of its two inputs is set", () => {
  const probe = stepsOf(serving).find((step) => textAt(step, "name")?.includes("probe"));
  const when = textAt(probe, "if") ?? "";

  // A caller who set only the bound is told so rather than ignored — the step
  // has to be selected for the gate to be able to say it.
  expect(when).toContain("probe-command");
  expect(when).toContain("probe-timeout");
});

test("the ramp runs the k6 this repo pinned, not whatever the machine has", async () => {
  const ramp = stepsOf(serving).find((step) => textAt(step, "name") === "Capacity ramp");
  expect(textAt(ramp, "run")).toContain("k6.sh");

  const fetcher = await Bun.file(`${root}/.github/actions/db-serving/k6.sh`).text();
  // Version and archive checksum, the pair Renovate moves together: the version
  // is a label and the SHA-256 is the contract.
  expect(fetcher).toMatch(/^K6_VERSION=v\d+\.\d+\.\d+$/mu);
  expect(fetcher).toMatch(/^K6_SHA256=[\da-f]{64}$/mu);
  expect(fetcher).toContain("sha256sum -c -");
  // The pin is only a pin while Renovate can find it.
  expect(fetcher).toContain("renovate: datasource=github-release-attachments depName=grafana/k6");
});

test("the job hands the serving gate every input it declares, each under its own name", () => {
  const passed = mapAt(stepUsing("actions/db-serving"), "with");
  const declared = Object.keys(mapAt(serving, "inputs"));

  // working-directory is the one input the wrapper leaves at its default: this
  // workflow's consumers are single-package repos, and a monorepo's path is a
  // decision rather than a pass-through.
  expect(declared.filter((name) => name !== "working-directory").toSorted()).toEqual(
    Object.keys(passed).toSorted(),
  );
  // An input handed on under a neighbour's name is a setting the consumer wrote
  // with a wrong answer beside it, and no run shows it.
  const crossed = Object.entries(passed).filter(([name, value]) => {
    const reference = new RegExp(`inputs(?:\\.${name}(?![\\w-])|\\[(['"])${name}\\1\\])`, "u");
    return typeof value !== "string" || !reference.test(value);
  });
  expect(crossed).toEqual([]);
});
