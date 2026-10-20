import fs from "node:fs";
import path from "node:path";
import { MODELS, listProviders, providerRecord } from "./providers.mjs";
import { writePrivateJson } from "./private-json.mjs";
import { listProviderPresets } from "./provider-presets.mjs";
export { MODELS, HAIKU_MODEL } from "./providers.mjs";
export const DEFAULT_SETTINGS = { model: { provider: "zenmux", id: MODELS[0].id } };
function validate(root,value) {
 if (!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).some(k=>k!=="model")) throw new Error("设置只接受 model");
 const m=value.model;
 if(!m || Object.keys(m).sort().join(",")!=="id,provider" || !providerRecord(root,m.provider).models.some(row=>row.id===m.id)) throw new Error("请选择已有服务中的模型");
 return value;
}
export function readAppSettings(root) {
 const file=path.join(root,"system/app-settings.json");
 if(!fs.existsSync(file))writePrivateJson(file,DEFAULT_SETTINGS);
 if(fs.lstatSync(file).isSymbolicLink())throw new Error("模型设置不能是符号链接");
 return structuredClone(validate(root,JSON.parse(fs.readFileSync(file,"utf8"))));
}
export function getAppSettings(root) { return {...readAppSettings(root),kernel:"openclaw",providers:listProviders(root),providerPresets:listProviderPresets()}; }
export function putAppSettings(root,value) { validate(root,value);writePrivateJson(path.join(root,"system/app-settings.json"),value);return getAppSettings(root); }
export function selectedModel(root,env=process.env) {
 const m=readAppSettings(root).model,p=providerRecord(root,m.provider);
 return {...m,providerRecord:p,baseUrl:p.baseUrl,apiKey:p.apiKey,protocol:p.protocol};
}
