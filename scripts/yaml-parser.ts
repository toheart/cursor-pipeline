/**
 * 轻量 YAML 解析器（无外部依赖）
 *
 * 供 pipeline-server.ts 和 generate-orchestrator.ts 共享使用。
 * 支持基本的 YAML 特性：嵌套对象、数组、多行文本（|）、变量替换。
 */

export function parseYaml(text: string): any {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  return parseYamlLines(lines, 0, 0).value;
}

function parseYamlLines(lines: string[], start: number, baseIndent: number): { value: any; end: number } {
  const result: any = {};
  let currentKey = "";
  let i = start;
  let isArray = false;
  const arr: any[] = [];

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trimStart();

    if (!trimmed || trimmed.startsWith("#")) { i++; continue; }

    const indent = raw.length - raw.trimStart().length;
    if (indent < baseIndent) break;

    if (trimmed.startsWith("- ")) {
      if (!isArray && !currentKey) isArray = true;

      if (isArray) {
        const itemContent = trimmed.slice(2).trim();
        if (itemContent.includes(": ")) {
          const obj: any = {};
          const [k, ...vs] = itemContent.split(": ");
          obj[k.trim()] = parseYamlValue(vs.join(": ").trim());
          const itemIndent = indent + 2;
          let j = i + 1;
          while (j < lines.length) {
            const nextRaw = lines[j];
            const nextTrimmed = nextRaw.trimStart();
            if (!nextTrimmed || nextTrimmed.startsWith("#")) { j++; continue; }
            const nextIndent = nextRaw.length - nextTrimmed.length;
            if (nextIndent <= indent) break;
            if (nextTrimmed.startsWith("- ") && nextIndent <= itemIndent) break;
            if (nextTrimmed.includes(": ") || nextTrimmed.endsWith(":")) {
              const colonIdx = nextTrimmed.indexOf(":");
              const nk = nextTrimmed.slice(0, colonIdx).trim();
              const nVal = nextTrimmed.slice(colonIdx + 1).trim();
              if (nVal === "" || nVal === "|") {
                let peekNext = j + 1;
                while (peekNext < lines.length && (!lines[peekNext].trim() || lines[peekNext].trim().startsWith("#"))) peekNext++;
                if (nVal === "|") {
                  const peekIndent = peekNext < lines.length ? lines[peekNext].length - lines[peekNext].trimStart().length : nextIndent + 2;
                  obj[nk] = collectMultilineText(lines, peekNext, peekIndent);
                  j = skipMultilineText(lines, peekNext, peekIndent);
                } else {
                  if (peekNext < lines.length) {
                    const peekLine = lines[peekNext];
                    const peekIndent = peekLine.length - peekLine.trimStart().length;
                    const sub = parseYamlLines(lines, peekNext, peekIndent);
                    obj[nk] = sub.value;
                    j = sub.end;
                  } else {
                    obj[nk] = "";
                    j++;
                  }
                }
              } else {
                obj[nk] = parseYamlValue(nVal);
                j++;
              }
            } else { j++; }
          }
          arr.push(obj);
          i = j;
        } else {
          arr.push(parseYamlValue(itemContent));
          i++;
        }
        continue;
      }
    }

    if (trimmed.includes(": ") || trimmed.endsWith(":")) {
      const colonIdx = trimmed.indexOf(":");
      const key = trimmed.slice(0, colonIdx).trim();
      const valPart = trimmed.slice(colonIdx + 1).trim();

      if (valPart === "" || valPart === "|") {
        let nextNonEmpty = i + 1;
        while (nextNonEmpty < lines.length && (!lines[nextNonEmpty].trim() || lines[nextNonEmpty].trim().startsWith("#"))) nextNonEmpty++;
        if (nextNonEmpty < lines.length) {
          const nextTrimmed = lines[nextNonEmpty].trimStart();
          const nextIndent = lines[nextNonEmpty].length - nextTrimmed.length;
          if (valPart === "|") {
            result[key] = collectMultilineText(lines, nextNonEmpty, nextIndent);
            i = skipMultilineText(lines, nextNonEmpty, nextIndent);
          } else if (nextTrimmed.startsWith("- ")) {
            const sub = parseYamlLines(lines, nextNonEmpty, nextIndent);
            result[key] = sub.value;
            i = sub.end;
          } else {
            const sub = parseYamlLines(lines, nextNonEmpty, nextIndent);
            result[key] = sub.value;
            i = sub.end;
          }
        } else {
          result[key] = "";
          i++;
        }
        currentKey = key;
      } else {
        result[key] = parseYamlValue(valPart);
        currentKey = key;
        i++;
      }
      continue;
    }
    i++;
  }

  return { value: isArray ? arr : result, end: i };
}

function collectMultilineText(lines: string[], start: number, baseIndent: number): string {
  const parts: string[] = [];
  let i = start;
  while (i < lines.length) {
    const raw = lines[i];
    if (raw.trim() === "") { parts.push(""); i++; continue; }
    const indent = raw.length - raw.trimStart().length;
    if (indent < baseIndent) break;
    parts.push(raw.slice(baseIndent));
    i++;
  }
  return parts.join("\n").trimEnd() + "\n";
}

function skipMultilineText(lines: string[], start: number, baseIndent: number): number {
  let i = start;
  while (i < lines.length) {
    const raw = lines[i];
    if (raw.trim() === "") { i++; continue; }
    const indent = raw.length - raw.trimStart().length;
    if (indent < baseIndent) break;
    i++;
  }
  return i;
}

function parseYamlValue(val: string): any {
  if (val === "true") return true;
  if (val === "false") return false;
  if (val === "null" || val === "~") return null;
  if (/^-?\d+$/.test(val)) return parseInt(val);
  if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val);
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    return val.slice(1, -1);
  return val;
}

export function replaceVars(text: string | undefined | null, vars: Record<string, string>): string {
  if (!text) return "";
  return text.replace(/\{(\w+)\}/g, (match, key) => vars[key] ?? match);
}
