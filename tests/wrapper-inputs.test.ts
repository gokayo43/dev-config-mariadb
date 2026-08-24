import { expect, test } from "bun:test";

const CHECK_CALL = /^gokayo43\/dev-config\/\.github\/workflows\/check\.yml@([0-9a-f]{40})$/;

/** `${{ inputs.build }}` and `${{ inputs['test-network'] }}` are one reference written two ways. */
const FORWARD = /^\$\{\{\s*inputs(?:\.([\w-]+)|\[(['"])([^'"]+)\2\])\s*\}\}$/;

/** The spec that installs dev-config, which has to name the commit the workflows call. */
const INSTALLS = /"@gokayo43\/dev-config": "github:gokayo43\/dev-config#([0-9a-f]{40})"/;

/** The sentence README.md's list of refused inputs opens with, which is what makes that list checkable. */
const REFUSED = "refused here rather than forwarded";

/** What a caller may write beside a called workflow's input name. */
type Argument = string | boolean;

/**
 * A workflow as the questions below read one: the keys they name and no others,
 * each optional because a file that has stopped carrying one is exactly what
 * they are here to catch.
 */
interface Workflow {
  readonly on?: {
    readonly workflow_call?: {
      readonly inputs?: Readonly<
        Record<string, { readonly type?: string; readonly default?: Argument }>
      >;
    };
  };
  readonly jobs?: Readonly<
    Record<string, { readonly uses?: string; readonly with?: Readonly<Record<string, Argument>> }>
  >;
}

const root = `${import.meta.dir}/..`;

async function workflow(path: string): Promise<Workflow> {
  const text = await Bun.file(`${root}/${path}`).text();
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the interface above is this suite's schema for the three workflows it reads; what the assertion claims is what every test below asserts
  return Bun.YAML.parse(text) as Workflow;
}

function inputsOf(
  read: Workflow,
): Readonly<Record<string, { readonly type?: string; readonly default?: Argument }>> {
  return read.on?.workflow_call?.inputs ?? {};
}

/** The job that calls dev-config's gate, which every question here is about. */
function call(
  read: Workflow,
  path: string,
): {
  readonly uses: string;
  readonly with: Readonly<Record<string, Argument>>;
} {
  const job = Object.values(read.jobs ?? {}).find(
    ({ uses }) => uses !== undefined && CHECK_CALL.test(uses),
  );
  if (job?.uses === undefined) {
    throw new Error(`${path} has no job calling dev-config's check.yml at a pinned commit`);
  }
  return { uses: job.uses, with: job.with ?? {} };
}

const alphabetically = (a: string, b: string): number => a.localeCompare(b);

const wrapper = await workflow(".github/workflows/check.yml");
const ci = await workflow(".github/workflows/ci.yml");
// The dev-config this repo installs is the dev-config its workflows pin — the
// last test here is what holds those two together — so its own check.yml is the
// input surface the wrapper is graded against, at the commit consumers get.
const upstream = await workflow("node_modules/@gokayo43/dev-config/.github/workflows/check.yml");

test("every input the wrapper declares reaches dev-config's check.yml under its own name", () => {
  const passes = Object.entries(call(wrapper, "check.yml").with);
  const passed = passes.flatMap(([key, value]) => {
    const forward = typeof value === "string" ? FORWARD.exec(value) : null;
    return forward === null ? [] : [[key, forward[1] ?? forward[3] ?? ""] as const];
  });
  // Three failures, and a run shows none of them: an input declared and never
  // handed on is a setting a consumer wrote that nothing reads, one handed on
  // under a neighbour's name is that silence with a wrong answer beside it, and
  // a key dev-config does not declare is a whole argument it ignores.
  expect(passed.map(([key]) => key).toSorted(alphabetically)).toEqual(
    Object.keys(inputsOf(wrapper)).toSorted(alphabetically),
  );
  expect(passed.filter(([key, from]) => key !== from)).toEqual([]);
  expect(passes.map(([key]) => key).filter((key) => !(key in inputsOf(upstream)))).toEqual([]);
});

test("a pass-through is declared exactly as dev-config declares it", () => {
  const differs = Object.entries(inputsOf(wrapper)).filter(
    ([name, { type, default: fallback }]) => {
      const theirs = inputsOf(upstream)[name];
      return theirs === undefined || type !== theirs.type || fallback !== theirs.default;
    },
  );
  // A type or a default of this repo's own is a wrapper that answers for
  // dev-config: a caller who omits the input gets this file's idea of what it
  // means, and the workflow that reads it never sees the difference.
  expect(differs).toEqual([]);
});

test("README.md's account of the input surface is dev-config's, minus the database job", async () => {
  const readme = await Bun.file(`${root}/README.md`).text();
  const byName = (a: readonly [string, string], b: readonly [string, string]): number =>
    alphabetically(a[0], b[0]);
  const tabled = [...readme.matchAll(/^\| `([\w-]+)` +\| `(\w+)` +\|$/gm)].map(
    ([, name, type]) => [name ?? "", type ?? ""] as const,
  );
  expect(tabled.toSorted(byName)).toEqual(
    Object.entries(inputsOf(wrapper))
      .map(([name, { type }]) => [name, type ?? ""] as const)
      .toSorted(byName),
  );

  // Collapsed first: markdown wraps a paragraph wherever the width runs out,
  // so the sentence this looks for is a line break away from being unfindable.
  const paragraph = readme
    .split("\n\n")
    .map((block) => block.replaceAll("\n", " "))
    .find((block) => block.includes(REFUSED));
  const refused = [...(paragraph ?? "").matchAll(/`([\w-]+)`/g)].map(([, name]) => name ?? "");
  // Both halves are prose about a file in another repo, which is the statement
  // here most able to go quietly out of date: an input dev-config adds and this
  // page names in neither place is one nobody decided about.
  expect([...tabled.map(([name]) => name), ...refused].toSorted(alphabetically)).toEqual(
    Object.keys(inputsOf(upstream))
      .filter((name) => name !== "database")
      .toSorted(alphabetically),
  );
});

test("the wrapper leaves dev-config's database job off and offers no way to turn it on", () => {
  expect(call(wrapper, "check.yml").with["database"]).toBe(false);
  expect(Object.keys(inputsOf(wrapper))).not.toContain("database");
});

test("this repo is gated by, and installs, the dev-config it hands its consumers", async () => {
  const pinned = CHECK_CALL.exec(call(wrapper, "check.yml").uses)?.[1];
  expect(pinned).toMatch(/^[0-9a-f]{40}$/);
  expect(CHECK_CALL.exec(call(ci, "ci.yml").uses)?.[1]).toBe(pinned);
  // The third carrier of the same commit: the install is what the lanes above
  // read dev-config's input surface out of, and a manifest left behind grades
  // this wrapper against a version no consumer is being handed.
  expect(INSTALLS.exec(await Bun.file(`${root}/package.json`).text())?.[1]).toBe(pinned);
});
