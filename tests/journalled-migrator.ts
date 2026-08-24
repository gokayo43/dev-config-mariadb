/**
 * The `db:migrate` of a fixture project on the shape both consumers run:
 * drizzle's own MySQL migrator over its own journal, against the database
 * DATABASE_URL names.
 *
 * A real migrator rather than a stand-in, because what the suite is asking is
 * what the real one does with a migration it has already applied — whether the
 * journal it keeps is honest about that — and a hand-written substitute could
 * only answer what its author already believed. mysql2 is the driver both
 * consumers use, so this is their migrator and not an approximation of it.
 */
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";

const url = Bun.env["DATABASE_URL"];
if (url === undefined || url === "") throw new Error("DATABASE_URL is not set");

const migrationsFolder = Bun.argv[2];
if (migrationsFolder === undefined) {
  throw new Error("usage: journalled-migrator.ts <migrations folder>");
}

const connection = await mysql.createConnection(url);
await migrate(drizzle(connection), { migrationsFolder });
await connection.end();
