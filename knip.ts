import type { KnipConfig } from "knip";

import { base } from "@gokayo43/dev-config/knip.base.ts";

const config: KnipConfig = {
  ...base,
  // A gate's `*.main.ts` is what GitHub runs, so nothing here imports it.
  // Splitting the entry point out of the gate module is also what lets the
  // coverage floor mean something: the module the suite drives reports its own
  // coverage rather than carrying a block no test can reach.
  entry: [".github/actions/*/*.main.ts", "tests/*.ts"],
  project: [".github/actions/**/*.ts", "tests/**/*.ts"],
};

export default config;
