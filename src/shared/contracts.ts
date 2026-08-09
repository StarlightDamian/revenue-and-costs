import { Type } from "@sinclair/typebox";

export const UuidSchema = Type.String({ format: "uuid" });
export const IsoDateSchema = Type.String({ format: "date" });
