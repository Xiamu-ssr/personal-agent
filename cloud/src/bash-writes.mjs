import path from "node:path";
import fs from "node:fs";

function tokens(command) {
  const result = []; let word = "", quote = "";
  const flush = () => { if (word) result.push(word); word = ""; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "\\" && quote !== "'") { word += command[++i] || ""; continue; }
    if (quote) { if (c === quote) quote = ""; else word += c; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "#" && !word) { while (i < command.length && command[i] !== "\n") i++; }
    if (/[\s;|&<>]/.test(command[i] || "")) {
      flush();
      if (/[;|&<>\n]/.test(command[i])) {
        let op = command[i];
        if (command[i + 1] === op || op === "&" && command[i + 1] === ">" || op === ">" && command[i + 1] === "|") op += command[++i];
        result.push(op);
      }
    } else word += c;
  }
  flush(); return result;
}

function scriptWrites(script, add) {
  const variables = new Map();
  for (const m of script.matchAll(/\b(\w+)\s*=\s*(?:Path\s*\()?\s*(['"])(.*?)\2/g)) variables.set(m[1], m[3]);
  const literal = (value) => {
    const m = value.trim().match(/^(['"])([\s\S]*?)\1$/);
    return m ? m[2] : variables.get(value.trim());
  };
  for (const m of script.matchAll(/\bopen\(\s*([^,\n]+),\s*(?:mode\s*=\s*)?(['"])([^'"]+)\2/g)) if (/[wax+]/.test(m[3])) add(literal(m[1]));
  for (const m of script.matchAll(/(?:Path\(\s*(['"])(.*?)\1\s*\)|(\w+))\.(?:write_text|write_bytes|touch|unlink|mkdir|rmdir|chmod|rename|replace)\s*\(/g)) add(m[2] || variables.get(m[3]));
  for (const m of script.matchAll(/\b(writeFileSync|writeFile|appendFileSync|appendFile|unlinkSync|unlink|rmSync|rmdir|remove|mkdir|truncate|chmod|chown|rename|replace|copyfile|copy2|copy|move)\s*\(([^()\n]*)\)/g)) {
    const args = m[2].split(/,\s*/).map(literal);
    if (/^(?:copyfile|copy2|copy)$/.test(m[1])) add(args[1]);
    else { add(args[0]); if (/^(?:rename|replace|move)$/.test(m[1])) add(args[1]); }
  }
  for (const m of script.matchAll(/(?:system|execSync|exec)\(\s*(['"])(.*?)\1\s*\)/g)) for (const target of bashWriteTargets(m[2])) add(target);
}

export function bashWriteTargets(command, cwd = ".", depth = 0) {
  if (depth > 4) return [cwd];
  const targets = [], variables = new Map([["AGENT_ROOT", cwd], ["PWD", cwd]]);
  const expand = (s) => s?.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, a, b) => variables.get(a || b) ?? `$${a || b}`);
  const add = (s) => { if (s && s !== "-" && !/^\d+$/.test(s)) targets.push(path.resolve(cwd, expand(s))); };
  const execute = (input) => {
    let words = [...input];
    for (let i = 0; i < words.length; i++) if (/^(?:>|>>|>\||&>|<>|>&)$/.test(words[i])) { add(words[i + 1]); words.splice(i, 2); i--; }
    while (/^\w+=/.test(words[0] || "")) { const [key, ...value] = words.shift().split("="); variables.set(key, expand(value.join("="))); }
    while (["sudo", "env", "command", "builtin", "nohup", "timeout", "nice"].includes(words[0])) {
      const wrapper = words.shift();
      while (words[0]?.startsWith("-")) { const option = words.shift(); if (["-u", "-g", "-n", "--user", "--signal"].includes(option)) words.shift(); }
      if (wrapper === "timeout" && /^[\d.]+[smhd]?$/.test(words[0])) words.shift();
      while (/^\w+=/.test(words[0] || "")) { const [key, ...value] = words.shift().split("="); variables.set(key, expand(value.join("="))); }
    }
    const name = path.basename(words.shift() || ""), args = words.map(expand), operands = args.filter((a) => !a.startsWith("-"));
    if (name === "cd") { cwd = path.resolve(cwd, args[0] || "."); variables.set("PWD", cwd); return; }
    if (["bash", "sh", "zsh"].includes(name) && args.includes("-c")) { targets.push(...bashWriteTargets(args[args.indexOf("-c") + 1] || "", cwd, depth + 1)); return; }
    const option = (...names) => {
      for (const key of names) {
        const index = args.indexOf(key); if (index >= 0) return args[index + 1];
        const equal = args.find((a) => a.startsWith(key + "=")); if (equal) return equal.slice(key.length + 1);
        if (/^-[a-z]$/.test(key)) { const joined = args.find((a) => a.startsWith(key) && a.length > 2); if (joined) return joined.slice(2); }
      }
    };
    if (["rm", "mv", "chmod", "chown", "chgrp", "touch", "truncate", "rmdir", "unlink", "mkdir"].includes(name)) operands.forEach(add);
    else if (["cp", "rsync", "install"].includes(name)) {
      if (name === "install" && args.includes("-d")) operands.forEach(add);
      else if (operands.length > 1 || option("-t", "--target-directory")) {
        const directory = option("-t", "--target-directory"), destination = directory || operands.at(-1);
        let targetDirectory = !!directory || destination?.endsWith("/");
        try { targetDirectory ||= fs.statSync(path.resolve(cwd, destination)).isDirectory(); } catch {}
        if (name === "cp" && targetDirectory) for (const source of operands.filter((p) => p !== destination)) add(path.join(destination, path.basename(source)));
        else add(destination);
      }
    } else if (name === "ln") {
      add(option("-t", "--target-directory") || (operands.length > 1 ? operands.at(-1) : "."));
      if (!args.some((a) => /^-[^-]*s/.test(a) || a === "--symbolic")) add(operands[0]);
    } else if (name === "tee") operands.forEach(add);
    else if (name === "sed" && args.some((a) => a === "--in-place" || a.startsWith("--in-place=") || /^-[^-]*i/.test(a))) operands.forEach(add);
    else if (name === "find") {
      if (args.includes("-delete")) operands.forEach(add);
      const exec = args.findIndex((a) => ["-exec", "-execdir"].includes(a));
      if (exec >= 0) {
        const nested = args.slice(exec + 1).filter((a) => a !== "+").map((a) => a.replaceAll("{}", operands[0] || "."));
        targets.push(...bashWriteTargets(nested.map((a) => '"' + a.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"').join(" "), cwd, depth + 1));
      }
    }
    else if (name === "pdftotext") {
      const files = args.filter((a) => a === "-" || !a.startsWith("-"));
      add(files.length > 1 ? files.at(-1) : files[0]?.replace(/\.pdf$/i, ".txt"));
    }
    else if (name === "tar") {
      const flags = args.find((a) => /^-?[a-zA-Z]+$/.test(a)) || "";
      if (args.includes("--extract") || /x/.test(flags)) add(option("-C", "--directory") || ".");
      else if (args.some((a) => ["--create", "--append", "--update", "--delete"].includes(a)) || /[cru]/.test(flags)) {
        const index = args.findIndex((a) => /^-?[a-zA-Z]*f$/.test(a));
        add(option("-f", "--file") || (index >= 0 ? args[index + 1] : undefined));
      }
    } else if (name === "unzip" && !args.some((a) => /^-[^-]*[lpZ]/.test(a))) add(option("-d") || ".");
    else if (["python", "python3", "python3.11", "node", "perl", "ruby", "awk"].includes(name)) args.forEach((a) => {
      scriptWrites(a, add);
      if (name === "awk") for (const m of a.matchAll(/>+\s*(['"])(.*?)\1/g)) add(m[2]);
    });
  };
  let part = [];
  for (const token of tokens(command)) {
    if ([";", "|", "||", "&&", "&", "\n"].includes(token)) { execute(part); part = []; }
    else part.push(token);
  }
  execute(part);
  // Heredoc scripts retain their quoted paths in the original command.
  if (command.includes("<<")) scriptWrites(command, add);
  return targets;
}
