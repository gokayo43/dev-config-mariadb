/**
 * The other shape of `db:migrate` this gate is written for: a hand-rolled runner
 * with no journal, which applies every file on every run. Against one of these
 * the second replay is what proves the SQL is re-runnable, and a fixture project
 * carrying this one is how the suite drives that half.
 */
import { readdir } from "node:fs/promises";

import { connection } from "../.github/actions/db-replay/database.ts";

const url = Bun.env["DATABASE_URL"];
if (url === undefined || url === "") throw new Error("DATABASE_URL is not set");

const folder = Bun.argv[2];
if (folder === undefined) throw new Error("usage: replaying-migrator.ts <migrations folder>");

const files = (await readdir(folder)).filter((file) => file.endsWith(".sql")).toSorted();
// Through the gate's own connection rather than a bare `new SQL(url)`, and that
// is a fact about consumers rather than a shortcut for this fixture: a migrator
// written on Bun's SQL client meets MySQL 8's default authentication the same
// way the gates do, and database.ts is the one place this repo states what that
// takes.
const client = connection(url);
for (const file of files) {
  // Statement by statement: a MySQL-family driver refuses several in one call
  // unless the connection asked for it, and a drizzle migration file is a list
  // of them.
  for (const statement of (await Bun.file(`${folder}/${file}`).text()).split(";")) {
    if (statement.trim() !== "") await client.unsafe(statement);
  }
}
await client.close();
