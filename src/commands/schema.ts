import { zodToJsonSchema } from "zod-to-json-schema";
import { PortableSession } from "../schema/portable.js";

export function schemaCommand(): void {
  const jsonSchema = zodToJsonSchema(PortableSession, "PortableSession");
  console.log(JSON.stringify(jsonSchema, null, 2));
}