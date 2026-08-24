import { dirname } from "node:path";

import { isForeign, isList, mapAt, textAt } from "../.github/actions/_lib/foreign.ts";

/**
 * The wrapper as both suites here read it. Two of them ask about the same file
 * for different reasons — `wrapper-inputs.test.ts` grades what it declares and
 * hands on, `mariadb.ts` needs the server the shipped job actually runs — and
 * the file is the one place either of them should be reading that from.
 */
export const root = dirname(import.meta.dir);

export const WRAPPER = ".github/workflows/check.yml";

/**
 * The image the workflow hands the replay gate, wherever in it that step sits.
 * Walked rather than addressed by job and step index, so that moving the step
 * does not move this: what is wanted is "the image the shipped gate is given",
 * not where it is written.
 */
function imagePassedIn(document: unknown): string | undefined {
  if (isList(document)) {
    return document.map((node) => imagePassedIn(node)).find((found) => found !== undefined);
  }
  if (!isForeign(document)) return undefined;
  const given = textAt(mapAt(document, "with"), "db-image");
  if (given !== undefined) return given;
  return Object.values(document)
    .map((node: unknown) => imagePassedIn(node))
    .find((found) => found !== undefined);
}

/** The image the gate is given, refused rather than defaulted: a suite cannot invent the server it grades against. */
export async function dbImage(): Promise<string> {
  const found = imagePassedIn(Bun.YAML.parse(await Bun.file(`${root}/${WRAPPER}`).text()));
  if (found === undefined) {
    throw new Error(
      `no db-image is passed to the db-replay action in ${WRAPPER} — the suite drives the gate against the image the shipped job runs, and cannot find it`,
    );
  }
  return found;
}
