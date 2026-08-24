import type { Tree } from "./tree.ts";

/** One migration as a lineage holds it: a file, and the journal entry that orders it. */
export interface Migration {
  readonly tag: string;
  /** The journal's own clock. An applied migration is recognised by this and nothing else. */
  readonly when: number;
  readonly sql: string;
}

/**
 * A drizzle lineage under `dir`, in the shape `drizzle-kit generate` writes for
 * MySQL: the journal beside the files it names. `dialect: "mysql"` is the whole
 * of what makes it MySQL's rather than Postgres's, and the migrator refuses a
 * folder with no journal in it at all.
 */
export function lineage(dir: string, ...migrations: readonly Migration[]): Tree {
  const journal = {
    version: "5",
    dialect: "mysql",
    entries: migrations.map(({ when, tag }, idx) => ({
      idx,
      version: "5",
      when,
      tag,
      breakpoints: true,
    })),
  };
  return {
    [`${dir}/meta/_journal.json`]: `${JSON.stringify(journal, undefined, 2)}\n`,
    ...Object.fromEntries(migrations.map(({ tag, sql }) => [`${dir}/${tag}.sql`, sql])),
  };
}

/** The project's declaration of how it migrates, and of where its lineage is. */
export function migratesFrom(migrator: string, dir: string): Tree {
  return scripted(`bun run ${migrator} ./${dir}`);
}

/** A project whose `db:migrate` is whatever the case needs it to be. */
export function scripted(script: string): Tree {
  return {
    "package.json": `${JSON.stringify(
      { name: "fixture", private: true, type: "module", scripts: { "db:migrate": script } },
      undefined,
      2,
    )}\n`,
  };
}
