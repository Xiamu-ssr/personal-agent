// Small, dependency-free Markdown renderer for the offline product spec.
// Raw HTML is escaped. Links and images remain text, so prompts cannot navigate or fetch.
function renderMarkdown(source) {
  const escape = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]));
  function inline(text) {
    const code = [];
    let html = escape(text).replace(/(`+)([\s\S]*?)\1/g, (_, ticks, value) => `\u0000${code.push(`<code>${value}</code>`) - 1}\u0000`);
    html = html.replace(/!?\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => `<span class="md-link">${label} (${url})</span>`)
      .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a || b}</strong>`)
      .replace(/(^|\s)\*([^*\n]+)\*(?=\s|[，。,.!?;:]|$)/g, "$1<em>$2</em>");
    return html.replace(/\u0000(\d+)\u0000/g, (_, i) => code[+i] || "");
  }
  const indent = line => /^ */.exec(line)[0].length;
  const list = line => /^( *)([-+*]|\d+[.)]) +(.+)$/.exec(line);
  const fence = line => /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  const heading = line => /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  const rule = line => /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
  function cells(line) {
    const text = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
    const parts = []; let cell = "", code = false;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\\" && text[i + 1] === "|") { cell += "|"; i++; }
      else if (text[i] === "`") { code = !code; cell += text[i]; }
      else if (text[i] === "|" && !code) { parts.push(cell.trim()); cell = ""; }
      else cell += text[i];
    }
    parts.push(cell.trim()); return parts;
  }
  const table = (lines, i) => lines[i]?.includes("|") && i + 1 < lines.length && cells(lines[i + 1]).every(c => /^:?-{3,}:?$/.test(c)) && cells(lines[i]).length === cells(lines[i + 1]).length;
  const block = (lines, i) => fence(lines[i]) || heading(lines[i]) || rule(lines[i]) || list(lines[i]) || /^\s*>/.test(lines[i]) || table(lines, i);
  function blocks(lines) {
    const out = []; let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const f = fence(line), h = heading(line), li = list(line);
      if (f) {
        const code = [], language = f[2].trim().split(/\s/)[0]; i++;
        const closing = new RegExp(`^ {0,3}${f[1][0]}{${f[1].length},}\\s*$`);
        while (i < lines.length && !closing.test(lines[i])) code.push(lines[i++]);
        if (i < lines.length) i++;
        out.push(`<pre><code${/^[\w+-]+$/.test(language) ? ` data-language="${escape(language)}"` : ""}>${escape(code.join("\n"))}</code></pre>`);
      } else if (h) {
        out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++;
      } else if (rule(line)) {
        out.push("<hr>"); i++;
      } else if (table(lines, i)) {
        const headers = cells(line), alignment = cells(lines[i + 1]).map(c => c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left");
        const cell = (tag, value, col) => `<${tag}${tag === "th" ? ' scope="col"' : ""} style="text-align:${alignment[col]}">${inline(value)}</${tag}>`;
        out.push('<div class="md-table"><table><thead><tr>' + headers.map((v, col) => cell("th", v, col)).join("") + "</tr></thead><tbody>"); i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
          const row = cells(lines[i++]);
          out.push("<tr>" + headers.map((_, col) => cell("td", row[col] || "", col)).join("") + "</tr>");
        }
        out.push("</tbody></table></div>");
      } else if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*> ?/, ""));
        out.push(`<blockquote>${blocks(quote)}</blockquote>`);
      } else if (li) {
        const base = li[1].length, ordered = /^\d/.test(li[2]), tag = ordered ? "ol" : "ul";
        out.push(`<${tag}${ordered && parseInt(li[2], 10) !== 1 ? ` start="${parseInt(li[2], 10)}"` : ""}>`);
        while (i < lines.length) {
          const item = list(lines[i]);
          if (!item || item[1].length !== base || /^\d/.test(item[2]) !== ordered) break;
          const contents = [item[3]], offset = lines[i].length - item[3].length; i++;
          while (i < lines.length) {
            if (!lines[i].trim()) { contents.push(""); i++; continue; }
            if (indent(lines[i]) <= base) break;
            const continuation = lines[i++];
            contents.push(continuation.slice(Math.min(offset, indent(continuation))));
          }
          out.push(`<li>${blocks(contents)}</li>`);
        }
        out.push(`</${tag}>`);
      } else {
        const paragraph = [line.trim()]; i++;
        while (i < lines.length && lines[i].trim() && !block(lines, i)) paragraph.push(lines[i++].trim());
        out.push(`<p>${inline(paragraph.join(" "))}</p>`);
      }
    }
    return out.join("");
  }
  return blocks(String(source).replace(/\r\n/g, "\n").replace(/\t/g, "    ").split("\n"));
}
