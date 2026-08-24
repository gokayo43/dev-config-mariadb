import { expect, test } from "bun:test";

const CHECK_CALL = /^gokayo43\/dev-config\/\.github\/workflows\/check\.yml@([0-9a-f]{40})$/;

/** `${{ inputs.build }}` and `${{ inputs['test-network'] }}` are one reference written two ways. */
const FORWARD = /^\$\{\{\s*inputs(?:\.([\w-]+)|\[(['"])([^'"]+)\2\])\s*\}\}$/;

/** The spec that installs dev-config, which has to name the commit the workflows call. */
const INSTALLS = /"@gokayo43\/dev-config": "github:gokayo43\/dev-config#([0-9a-f]{40})"/;

/** What bun.lock records that spec as having resolved to — an abbreviated commit. */
const LOCKED = /"@gokayo43\/dev-config@github:gokayo43\/dev-config#([0-9a-f]+)"/;

/** The sentence README.md's list of refused inputs opens with, which is what makes that list checkable. */
const REFUSED = "refused here rather than forwarded";

const INSTALLED = "node_modules/@gokayo43/dev-config/.github/workflows/check.yml";

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

function parse(text: string): Workflow {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the interface above is this suite's schema for the three workflows it reads; what the assertion claims is what every test below asserts
  return Bun.YAML.parse(text) as Workflow;
}

async function workflow(path: string): Promise<Workflow> {
  return parse(await Bun.file(`${root}/${path}`).text());
}

/**
 * dev-config's `check.yml` as this repo has it installed, which is that pin's
 * own copy of the input surface every test below grades the wrapper against.
 *
 * It is on disk because a `github:` dependency installs a checkout of the whole
 * repository — `.github/` is outside dev-config's `files` allowlist, so a packed
 * install would not carry it. That is the invariant the diagnostic states: if it
 * fires, dev-config is being installed packed and this suite needs another way
 * to read what it declares.
 */
async function installed(): Promise<Workflow> {
  const file = Bun.file(`${root}/${INSTALLED}`);
  if (!(await file.exists())) {
    throw new Error(
      `${INSTALLED} is not there — this suite reads dev-config's input surface out of the install, which carries its workflows only because a github: dependency is a full checkout rather than a packed tarball. Run bun install; if the file is still missing, dev-config is packed now and this suite has to read that surface from somewhere else.`,
    );
  }
  return parse(await file.text());
}

/** A group the pattern that matched has to have captured, since every branch of it captures one. */
function captured(value: string | undefined, what: string): string {
  if (value === undefined) throw new Error(`${what} matched and captured nothing`);
  return value;
}

function inputsOf(
  read: Workflow,
): Readonly<Record<string, { readonly type?: string; readonly default?: Argument }>> {
  return read.on?.workflow_call?.inputs ?? {};
}

/**
 * The job that calls dev-config's gate. Exactly one, and the count is the check
 * rather than a detail of finding it: a second job calling the same workflow is
 * how the Postgres database job gets turned on beside a wrapper that reads as
 * leaving it off, and reading only the first is how nobody would notice.
 */
function call(
  read: Workflow,
  path: string,
): { readonly uses: string; readonly with: Readonly<Record<string, Argument>> } {
  const jobs = Object.values(read.jobs ?? {}).filter(
    ({ uses }) => uses !== undefined && CHECK_CALL.test(uses),
  );
  const [job] = jobs;
  if (jobs.length !== 1 || job?.uses === undefined) {
    throw new Error(
      `${path} must have exactly one job calling dev-config's check.yml at a pinned commit, and has ${jobs.length}`,
    );
  }
  return { uses: job.uses, with: job.with ?? {} };
}

/** Whether the value written beside an input name hands a caller's input on rather than deciding it here. */
function forwards(value: Argument): value is string {
  return typeof value === "string" && FORWARD.test(value);
}

const alphabetically = (a: string, b: string): number => a.localeCompare(b);

const wrapper = await workflow(".github/workflows/check.yml");
const ci = await workflow(".github/workflows/ci.yml");
const upstream = await installed();

test("every input the wrapper declares reaches dev-config's check.yml under its own name", () => {
  const passes = Object.entries(call(wrapper, "check.yml").with);
  const passed = passes.flatMap(([key, value]) => {
    if (!forwards(value)) return [];
    const forward = FORWARD.exec(value);
    return [[key, captured(forward?.[1] ?? forward?.[3], "FORWARD")] as const];
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
    ([, name, type]) =>
      [captured(name, "the input table"), captured(type, "the input table")] as const,
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
  if (paragraph === undefined) {
    throw new Error(`README.md has no paragraph saying what is "${REFUSED}"`);
  }
  const refused = [...paragraph.matchAll(/`([\w-]+)`/g)].map(([, name]) =>
    captured(name, "the refused list"),
  );
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
  // Everything else in the call is a caller's input handed on; a second literal
  // would be this workflow answering for a consumer in a value nothing here
  // declares, and dev-config cannot tell that from the consumer's own answer.
  expect(
    Object.entries(call(wrapper, "check.yml").with).filter(([, value]) => !forwards(value)),
  ).toEqual([["database", false]]);
  expect(Object.keys(inputsOf(wrapper))).not.toContain("database");
});

test("this repo is gated by, and installs, the dev-config it hands its consumers", async () => {
  const pinned = captured(CHECK_CALL.exec(call(wrapper, "check.yml").uses)?.[1], "CHECK_CALL");
  expect(captured(CHECK_CALL.exec(call(ci, "ci.yml").uses)?.[1], "CHECK_CALL")).toBe(pinned);
  // The other two carriers of the same commit: the manifest decides which
  // dev-config the lanes above read, and the lockfile is what `bun install
  // --frozen-lockfile` actually resolves — a manifest and a lock that disagree
  // put a third version on disk with nothing saying so.
  expect(INSTALLS.exec(await Bun.file(`${root}/package.json`).text())?.[1]).toBe(pinned);
  expect(pinned).toStartWith(
    captured(LOCKED.exec(await Bun.file(`${root}/bun.lock`).text())?.[1], "LOCKED"),
  );
});
