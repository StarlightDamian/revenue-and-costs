declare module "pg-copy-streams" {
  import type { Duplex } from "node:stream";
  import type { Submittable } from "pg";

  export function from(command: string): Submittable & Duplex;
}
