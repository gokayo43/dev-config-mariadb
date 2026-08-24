import { afterAll } from "bun:test";

import { stop } from "./mariadb.ts";

/**
 * The one hook that has to outlive every test file, registered where `bun test`
 * runs it once for the whole run rather than at the end of whichever file
 * imported it first. `mariadb.ts` says why that distinction is the difference
 * between a shared server and a trap; importing it here starts nothing.
 */
afterAll(stop);
