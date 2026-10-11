import path from "node:path";
import { z } from "zod";
import { readJson } from "./store.mjs";
import { writePrivateJson } from "./connectors.mjs";

export const profileSchema = z.object({ avatar: z.object({
  shape: z.enum(["bean", "girl", "boy", "cat"]),
  palette: z.enum(["mist", "dusk", "mint", "sakura"]),
}).strict() }).strict();
export const defaultProfile = () => ({ avatar: { shape: "bean", palette: "mist" } });
const filename = (root) => path.join(root, "system/app-profile.json");

export function getProfile(root) {
  const result = profileSchema.safeParse(readJson(filename(root), null));
  return result.success ? result.data : defaultProfile();
}

export function putProfile(root, value) {
  const result = profileSchema.safeParse(value);
  if (!result.success) throw new Error("avatar.shape 只能是 bean、girl、boy、cat；avatar.palette 只能是 mist、dusk、mint、sakura，且需同时提供");
  writePrivateJson(filename(root), result.data);
  return result.data;
}
