import type { KnipConfig } from "knip";

import { base } from "@gokayo43/dev-config/knip.base.ts";

const config: KnipConfig = {
  ...base,
  entry: ["tests/*.ts"],
  project: ["tests/**/*.ts"],
};

export default config;
