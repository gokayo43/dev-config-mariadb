/**
 * An escape hatch a caller writes in a workflow, read the one way every one of
 * them is read here: one entry per line, each carrying the reason it exists.
 *
 * **This is a checked-in copy of the allowlist half of dev-config's
 * `.github/actions/_lib/gate.ts` at the pinned SHA**, for the reason
 * `annotations.ts` gives at length and CLAUDE.md carries as a carve-out: an
 * action runs from a checkout with no `node_modules` above it, so there is no
 * import that reaches the original. dev-config#69 is where ending that is
 * argued, and a bug fixed there is a bug still here until somebody carries it
 * over.
 *
 * Deltas from upstream, both about what this repo has rather than about the
 * rule:
 *   * `Allowlist.problems` is `readonly string[]` rather than their
 *     `Problem[]`, which is `annotations.ts`'s delta followed through.
 *   * their `deadEntries` is left out. It serves two gates that can be handed
 *     the subjects they still grade as a set; the one allowlist here parses its
 *     entries into a method and a path first, and classifies them itself —
 *     `route-coverage.ts` says why at the classifier.
 */

/** The separator oxlint uses between a suppression and its reason, and every allowlist here follows it. */
const REASON = " -- ";

/**
 * One entry per line — not space-separated, because an entry contains spaces:
 * the method and path of a route, and the reason written beside it. The reason
 * is prose, prose contains commas, and an entry that ended at one would be
 * graded as two: a subject stripped of the reason written for it, and half a
 * sentence read as a subject nobody wrote. Two diagnostics, both true of an
 * input nobody typed.
 */
function entriesIn(value: string): string[] {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/**
 * A gate takes one of these whole rather than its `entries`: the reason on each
 * entry is enforced by reporting `problems`, and a signature that accepted the
 * list alone would let a caller typecheck while dropping that half.
 */
export interface Allowlist {
  /** Each entry with its reason stripped: the part a gate compares against. */
  readonly entries: readonly string[];
  /**
   * The subjects behind `problems`, so that a gate with a second rule about an
   * entry can leave the ones already refused alone: an entry the reader is
   * being sent back to anyway earns one diagnostic, not two.
   */
  readonly unreasoned: ReadonlySet<string>;
  /** One per entry that waives something and says nothing about why. */
  readonly problems: readonly string[];
}

/**
 * An allowlist input, as the list a gate compares against plus what is wrong
 * with it. Every entry carries `-- why`, the same price a lint directive pays:
 * an exemption whose reason nobody had to write is one nobody has to justify,
 * and a year later it is indistinguishable from a bug someone silenced.
 *
 * A reasonless entry still waives its subject — the gate fails on the missing
 * reason, and reporting the waived subject as well would be two diagnostics for
 * one mistake.
 */
export function allowlistFrom(value: string, input: string): Allowlist {
  const read = entriesIn(value).map((item) => {
    const [subject = "", ...reason] = item.split(REASON);
    return { subject: subject.trim(), reasoned: reason.join(REASON).trim() !== "" };
  });

  const unreasoned = read.filter(({ reasoned }) => !reasoned).map(({ subject }) => subject);

  return {
    entries: read.map(({ subject }) => subject),
    unreasoned: new Set(unreasoned),
    problems: unreasoned.map(
      (subject) =>
        `${input} waives ${subject} without saying why — write '${subject}${REASON}<reason>', the same price a lint directive pays`,
    ),
  };
}
