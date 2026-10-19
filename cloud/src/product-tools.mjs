// Product capabilities exposed to the OpenClaw plugin. Validation stays next to each capability.
import { z } from 'zod';
export function defineTool(name, description, shape, execute) {
  const schema = z.object(shape);
  return { name, description, parameters: z.toJSONSchema(schema, { unrepresentable: 'any' }),
    execute: (args, context) => execute(schema.parse(args ?? {}), context) };
}
