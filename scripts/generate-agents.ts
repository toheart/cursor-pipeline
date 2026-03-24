/**
 * 从 YAML 模板生成 .cursor/agents/*.md 文件
 *
 * 用法: bun run generate-agents.ts <template.yaml> [output-dir]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// ─── 轻量 YAML 解析（与 pipeline-server.ts 保持一致） ───
function parseYaml(text: string): any {
  const lines = text.split("\n");
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
          let j = i + 1;
          while (j < lines.length) {
            const nextRaw = lines[j];
            const nextTrimmed = nextRaw.trimStart();
            if (!nextTrimmed || nextTrimmed.startsWith("#")) { j++; continue; }
            const nextIndent = nextRaw.length - nextTrimmed.length;
            if (nextIndent <= indent) break;
            if (nextTrimmed.startsWith("- ")) break;
            if (nextTrimmed.includes(": ")) {
              const [nk, ...nvs] = nextTrimmed.split(": ");
              const nVal = nvs.join(": ").trim();
              if (nVal === "|") {
                obj[nk.trim()] = collectMultilineText(lines, j + 1, nextIndent + 2);
                j = skipMultilineText(lines, j + 1, nextIndent + 2);
              } else if (nVal === "") {
                const sub = parseYamlLines(lines, j + 1, nextIndent + 2);
                obj[nk.trim()] = sub.value;
                j = sub.end;
              } else {
                obj[nk.trim()] = parseYamlValue(nVal);
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

// ─── 变量替换 ───
function replaceVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, key) => vars[key] ?? match);
}

// ─── 生成单个 Agent .md ───
function generateAgentMd(agentName: string, agentDef: any, vars: Record<string, string>): string {
  const system = replaceVars(agentDef.system ?? "", vars);
  const description = replaceVars(agentDef.description ?? "", vars);
  const model = agentDef.model ?? "";
  const scope = replaceVars(agentDef.scope ?? "", vars);
  const skills = agentDef.skills ?? [];
  const autoFix = agentDef.auto_fix === true;

  let md = `# ${agentName}\n\n`;
  if (description) md += `> ${description}\n\n`;

  const meta: string[] = [];
  if (model) meta.push(`- **Model**: ${model}`);
  if (scope) meta.push(`- **Scope**: \`${scope}\``);
  if (autoFix) meta.push(`- **Auto-fix**: 规范类问题自动修复`);
  if (skills.length) meta.push(`- **Skills**: ${skills.join(", ")}`);
  if (meta.length) md += meta.join("\n") + "\n\n";

  md += `## System Prompt\n\n${system}`;
  return md;
}

// orchestrator 由 AI 会话引导用户创建，不在此处生成

// ─── 主流程 ───
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Usage: bun run generate-agents.ts <template.yaml> [output-dir]");
  process.exit(1);
}

const templatePath = resolve(args[0]);
const outputDir = resolve(args[1] ?? ".cursor/agents");

if (!existsSync(templatePath)) {
  console.error(`Template not found: ${templatePath}`);
  process.exit(1);
}

const content = readFileSync(templatePath, "utf-8");
const template = parseYaml(content);
const variables = template.variables ?? {};

mkdirSync(outputDir, { recursive: true });

let count = 0;
for (const [name, def] of Object.entries(template.agents ?? {})) {
  const md = generateAgentMd(name, def as any, variables);
  const outPath = join(outputDir, `${name}.md`);
  writeFileSync(outPath, md);
  console.log(`  Generated: ${outPath}`);
  count++;
}

console.log(`\n  [!] orchestrator.md 需要通过 AI 会话创建，请在 Cursor 中激活 cursor-pipeline Skill 并按引导操作。`);

console.log(`\nDone. Generated ${count} agent files in ${outputDir}/`);
