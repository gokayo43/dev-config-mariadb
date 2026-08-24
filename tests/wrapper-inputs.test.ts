import { expect, test } from "bun:test";

const CHECK_CALL = /^gokayo43\/dev-config\/\.github\/workflows\/check\.yml@([0-9a-f]{40})$/;

/** `${{ inputs.build }}` and `${{ inputs['test-network'] }}` are one reference written two ways. */
const FORWARD = /^\$\{\{\s*inputs(?:\.([\w-]+)|\[(['"])([^'"]+)\2\])\s*\}\}$/;

/** What a caller may write beside a called workflow's input name. */
type Argument = string | boolean;

/**
 * A workflow of this repo's, as the questions below read one: the keys they
 * name and no others, each optional because a file that has stopped carrying
 * one is exactly what they are here to catch.
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

async function workflow(file: string): Promise<Workflow> {
  const text = await Bun.file(`${import.meta.dir}/../.github/workflows/${file}`).text();
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the interface above is this suite's schema for the two files it reads, both of them this repo's own; what the assertion claims is what every test below asserts
  return Bun.YAML.parse(text) as Workflow;
}

/** The job that calls dev-config's gate, which every question here is about. */
function call(read: Workflow): {
  readonly uses: string;
  readonly with: Readonly<Record<string, Argument>>;
} {
  const job = Object.values(read.jobs ?? {}).find(
    ({ uses }) => uses !== undefined && CHECK_CALL.test(uses),
  );
  return { uses: job?.uses ?? "", with: job?.with ?? {} };
}

const alphabetically = (a: string, b: string): number => a.localeCompare(b);

const wrapper = await workflow("check.yml");
const ci = await workflow("ci.yml");

test("every input the wrapper declares reaches dev-config's check.yml under its own name", () => {
  const passed = Object.entries(call(wrapper).with).flatMap(([key, value]) => {
    const forward = typeof value === "string" ? FORWARD.exec(value) : null;
    return forward === null ? [] : [[key, forward[1] ?? forward[3] ?? ""] as const];
  });
  // Two failures, and a run shows neither: an input declared and never handed
  // on is a setting a consumer wrote that nothing reads, and one handed on
  // under a neighbour's name is that silence with a wrong answer beside it.
  expect(passed.map(([key]) => key).toSorted(alphabetically)).toEqual(
    Object.keys(wrapper.on?.workflow_call?.inputs ?? {}).toSorted(alphabetically),
  );
  expect(passed.filter(([key, from]) => key !== from)).toEqual([]);
});

test("the wrapper leaves dev-config's database job off and offers no way to turn it on", () => {
  expect(call(wrapper).with["database"]).toBe(false);
  expect(Object.keys(wrapper.on?.workflow_call?.inputs ?? {})).not.toContain("database");
});

test("this repo is gated by the dev-config it hands its consumers", () => {
  expect(call(wrapper).uses).toMatch(CHECK_CALL);
  expect(CHECK_CALL.exec(call(ci).uses)?.[1]).toBe(CHECK_CALL.exec(call(wrapper).uses)?.[1]);
});
