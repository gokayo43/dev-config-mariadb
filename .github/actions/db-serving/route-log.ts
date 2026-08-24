/**
 * The protocol between an app and the route-coverage floor: where the app
 * serves its report, how it names a route registered for every method, and the
 * three shapes the report is made of.
 *
 * **This is dev-config's `route-log.ts` at the pinned SHA**, and unlike the
 * other copies in this repo it is a copy of something a consuming app really
 * can import — it is in dev-config's `files` allowlist, published as
 * `@gokayo43/dev-config/route-log.ts`, and `docs/exports/route-log.md` there is
 * its page. The app end of this contract imports it; only the gate end cannot,
 * because an action runs from a checkout with no `node_modules` above it.
 *
 * So this copy is held to the original rather than trusted: `tests/route-log.test.ts`
 * imports dev-config's own module — which resolves, in a test, from the install
 * — and fails when either string or any of the three shapes here has drifted
 * from it. A protocol whose two ends disagree is a floor that grades a payload
 * nobody sends, and this is the one copy in the tree where the original is
 * reachable from somewhere that a copy can be checked against it.
 *
 * The prose below is theirs, cut to what the gate end needs; the arguments for
 * every choice in it are on their page and in `docs/gates/db-serving.md` here.
 */

/**
 * Where an app serves the report. Any app under `ROUTE_LOG` answers here, and
 * leaves this path out of both lists it reports: an instrument is not one of
 * the routes the floor is about, and the gate's own two fetches are not the
 * scenario's traffic.
 */
export const ENDPOINT = "/__route-log";

/**
 * How a route registered for every method is named. Elysia spells that
 * `.all()`, which is where the word comes from; TanStack Start spells the same
 * thing `ANY` and its implementation translates. The gate credits such a route
 * with whichever method reached it.
 */
export const EVERY_METHOD = "ALL";

/** A route as both halves of the contract name it: the router's own pattern, not a URL. */
export interface Route {
  readonly method: string;
  readonly path: string;
}

/** One route the app has taken requests on, and how many it has taken. */
export interface Served extends Route {
  readonly count: number;
}

/** One fetch of the endpoint. */
export interface RouteLog {
  readonly routeTable: Route[];
  readonly counts: Served[];
}
