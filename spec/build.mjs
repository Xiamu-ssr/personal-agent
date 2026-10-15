// Run from any directory: node personal-agent/spec/build.mjs
// Compile the product spec and current prompt text into a single offline page.
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const dir = await fs.realpath(path.dirname(fileURLToPath(import.meta.url)));
const pageFile = path.join(dir, "index.html");
const START = "<!-- spec-build:start -->", END = "<!-- spec-build:end -->";
const [page, yamlText, parser, markdown] = await Promise.all([
  fs.readFile(pageFile, "utf8"),
  fs.readFile(path.join(dir, "spec.yaml"), "utf8"),
  fs.readFile(path.join(dir, "vendor/js-yaml.min.js"), "utf8"),
  fs.readFile(path.join(dir, "vendor/markdown.js"), "utf8"),
]);
const context = vm.createContext({});
vm.runInContext(parser, context, { timeout: 1000 });
const spec = context.jsyaml.load(yamlText, { schema: context.jsyaml.CORE_SCHEMA });
const validation = page.match(/\/\* spec-validation:start \*\/([\s\S]*?)\/\* spec-validation:end \*\//);
if (!validation) throw new Error("index.html 缺少共享校验代码标记");
vm.runInContext(validation[1], context, { timeout: 1000 });
const errors = context.validateSpec(spec);
if (errors.length) throw new Error("spec.yaml 校验失败：\n" + errors.join("\n"));

// Read only referenced text files; cloud modules are never evaluated.
const scheduleFile = "../cloud/seed/system/schedule.json";
const promptDir = path.join(dir, "prompts") + path.sep;
const files = [...new Set(spec.prompts.map(prompt => prompt.source.file))];
async function readSource(file) {
  const resolved = path.resolve(dir, file);
  if (file !== scheduleFile && (!resolved.startsWith(promptDir) || path.extname(resolved) !== ".md")) throw new Error(`提示词来源必须在 prompts/ 目录内：${file}`);
  const full = await fs.realpath(resolved);
  if (full !== resolved) throw new Error(`提示词来源不能是符号链接：${file}`);
  return (await fs.readFile(full, "utf8")).replace(/\r\n/g, "\n");
}
const sources = Object.fromEntries(await Promise.all(files.map(async file => [file, await readSource(file)])));
const schedule = sources[scheduleFile] === undefined ? [] : JSON.parse(sources[scheduleFile]);
if (!Array.isArray(schedule)) throw new Error("定时配置必须是数组");

function trigger(cron) {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-7])$/.exec(cron || "");
  if (!match || +match[1] > 59 || +match[2] > 23) throw new Error("定时提示词需要每天或每周的固定触发时间");
  const time = `${+match[2]}:${match[1].padStart(2, "0")}`;
  return match[3] === "*" ? `每天 ${time}` : `每周${"日一二三四五六"[+match[3] % 7]} ${time}`;
}

spec.prompts = spec.prompts.map(prompt => {
  const { source, ...product } = prompt;
  const raw = sources[source.file];
  if (source.file === scheduleFile) {
    const rows = schedule.filter(item => item?.id === source.item);
    if (rows.length !== 1 || typeof rows[0].prompt !== "string" || !rows[0].prompt.trim()) throw new Error(`定时提示词缺失或重复：${source.item}`);
    return { ...product, when: trigger(rows[0].cron), text: rows[0].prompt };
  }
  // The system prompt's author notes above its separator are not part of the prompt.
  const separator = source.file === "prompts/system-prompt.md" ? raw.indexOf("\n---\n") : -1;
  const text = (separator < 0 ? raw : raw.slice(separator + 5)).trim();
  if (!text) throw new Error(`提示词 ${prompt.id} 为空`);
  return { ...product, text };
});

// Keep the product service list in step with the released connector registry.
const registry = await fs.readFile(path.resolve(dir, "../cloud/connectors/index.mjs"), "utf8");
const released = [...registry.matchAll(/import\s+\w+\s+from\s+["']\.\/([^/]+)\/index\.mjs["']/g)].map(match => match[1]).sort();
const listed = spec.connectors.items.map(item => item.id).sort();
if (JSON.stringify(released) !== JSON.stringify(listed)) throw new Error("连接应用的产品目录与已发布服务不一致");

// Inert JSON and escaped Markdown keep prompt text from creating scripts or requests.
const json = value => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const generated = `${START}\n<!-- Generated locally by build.mjs. -->\n<script type="application/json" id="spec-data">${json(spec)}</script>\n<script id="markdown-renderer">\n${markdown.trim().replace(/<\/script/gi, "<\\/script")}\n</script>\n${END}`;
const start = page.indexOf(START), end = page.indexOf(END);
if (start < 0 || end < start || page.indexOf(START, start + START.length) >= 0 || page.indexOf(END, end + END.length) >= 0) throw new Error("index.html 的生成区标记缺失或重复");
const output = page.slice(0, start) + generated + page.slice(end + END.length);
if (output !== page) await fs.writeFile(pageFile, output);
console.log(`已构建 spec/index.html：${spec.domains.length} 个域、${spec.connectors.items.length} 个连接器、${spec.prompts.length} 条提示词`);
