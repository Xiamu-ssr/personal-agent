import { z } from "zod";

export async function toolResult(tools, name, args = {}) {
  const definition = tools.find((t) => t.name === name);
  if (!definition) throw new Error("Missing tool " + name);
  const result = await definition.handler(z.object(definition.inputSchema).parse(args), {});
  return { data: JSON.parse(result.content[0].text), isError: !!result.isError };
}

export async function callTool(tools, name, args = {}) {
  const result = await toolResult(tools, name, args);
  if (result.isError) throw new Error(result.data.error);
  return result.data;
}
