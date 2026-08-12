import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresTestSchema, type PostgresTestSchema } from "./postgres-harness.js";

describe("release database identity guard", () => {
  let database: PostgresTestSchema | undefined;

  beforeAll(async () => { database = await createPostgresTestSchema({ migrate: false }); });
  afterAll(async () => { await database?.cleanup(); });

  it("executes the embedded identity query against PostgreSQL", async () => {
    const script = await readFile("bin/push-remote.sh", "utf8");
    const query = script.match(/const result = await client\.query\(`([\s\S]*?)`\);/u)?.[1];
    expect(query, "release identity SQL must remain extractable and executable").toBeDefined();

    const result = await database!.pool.query<Record<string, unknown>>(query!);
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]).toMatchObject({
      database_name: expect.any(String),
      server_identity: expect.any(String),
      server_is_local: true,
      session_elevated: expect.any(Boolean),
      current_elevated: expect.any(Boolean),
      owns_database: expect.any(Boolean),
      owns_public_schema: expect.any(Boolean),
      can_create_database_object: expect.any(Boolean),
      can_create_public_object: expect.any(Boolean),
      current_membership_count: expect.any(Number),
      session_membership_count: expect.any(Number),
      session_has_limited_owner_membership: expect.any(Boolean),
      owns_public_objects: expect.any(Boolean),
    });
  });
});
