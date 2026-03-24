/**
 * Pipeline Server — Cursor Hooks 流水线状态追踪与可视化
 *
 * 单文件实现：HTTP API + WebSocket 实时推送 + 内嵌看板
 * 支持从 YAML 模板动态加载阶段定义和 Agent 角色
 *
 * 启动方式: bun run pipeline-server.ts [--template <path>]
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { parseArgs } from "node:util";

// ─── YAML 解析（轻量实现，无外部依赖） ───
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
          // 收集同级的 key-value
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
              if (nVal === "" || nVal === "|") {
                // 多行文本或嵌套对象
                const sub = parseYamlLines(lines, j + 1, nextIndent + 2);
                if (nVal === "|") {
                  obj[nk.trim()] = collectMultilineText(lines, j + 1, nextIndent + 2);
                  j = skipMultilineText(lines, j + 1, nextIndent + 2);
                } else {
                  obj[nk.trim()] = sub.value;
                  j = sub.end;
                }
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
        // 检查下一行缩进，判断是对象/数组/多行文本
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

// ─── 模板加载 ───
interface TemplateStageDef {
  name: string;
  label: string;
  parallel: boolean;
  gate: boolean;
  optional: boolean;
}

interface TemplateConfig {
  name: string;
  description: string;
  variables: Record<string, string>;
  stages: TemplateStageDef[];
  agents: Record<string, any>;
  raw: any;
}

function replaceVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, key) => vars[key] ?? match);
}

function loadTemplate(filePath: string): TemplateConfig {
  const content = readFileSync(filePath, "utf-8");
  const raw = parseYaml(content);

  const variables = raw.variables ?? {};
  const stages: TemplateStageDef[] = (raw.stages ?? []).map((s: any) => ({
    name: s.name,
    label: replaceVars(s.label ?? s.name, variables),
    parallel: Array.isArray(s.parallel),
    gate: s.gate === true,
    optional: s.optional === true,
  }));

  return { name: raw.name, description: raw.description ?? "", variables, stages, agents: raw.agents ?? {}, raw };
}

function listTemplates(dir: string): string[] {
  try {
    return readdirSync(dir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch { return []; }
}

// ─── 生成 Agent .md 文件 ───
function generateAgentMd(agentName: string, agentDef: any, vars: Record<string, string>): string {
  const system = replaceVars(agentDef.system ?? "", vars);
  const description = replaceVars(agentDef.description ?? "", vars);
  const model = agentDef.model ?? "";
  const skills = agentDef.skills ?? [];
  const autoFix = agentDef.auto_fix === true;

  let md = `# ${agentName}\n\n`;
  if (model) md += `Model: ${model}\n\n`;
  if (description) md += `> ${description}\n\n`;
  if (autoFix) md += `**Auto-fix**: 规范类问题自动修复\n\n`;
  if (skills.length) md += `**Skills**: ${skills.join(", ")}\n\n`;
  md += `## System Prompt\n\n${system}`;

  return md;
}

function generateAllAgents(template: TemplateConfig, outputDir: string) {
  mkdirSync(outputDir, { recursive: true });
  for (const [name, def] of Object.entries(template.agents)) {
    const md = generateAgentMd(name, def, template.variables);
    writeFileSync(join(outputDir, `${name}.md`), md);
  }
}

// ─── 配置 ───
const PORT = 19090;
const DATA_DIR = ".cursor/hooks/state";
const STATE_FILE = join(DATA_DIR, "pipeline-state.json");
const AUDIT_FILE = join(DATA_DIR, "audit.jsonl");
const EXPLORER_FILE = join(DATA_DIR, "explorer-conclusion.md");

mkdirSync(DATA_DIR, { recursive: true });

// 解析命令行参数
const { values: cliArgs } = parseArgs({
  options: {
    template: { type: "string", short: "t" },
    "templates-dir": { type: "string" },
    "generate-agents": { type: "boolean", default: false },
    "agents-dir": { type: "string", default: ".cursor/agents" },
  },
  strict: false,
});

// 加载模板（优先命令行指定，否则查找默认位置）
let activeTemplate: TemplateConfig | null = null;
const BUILTIN_TEMPLATES_DIR = resolve(import.meta.dir, "../templates");
const templatesDir = (cliArgs["templates-dir"] as string) ?? BUILTIN_TEMPLATES_DIR;

if (cliArgs.template) {
  const tplPath = resolve(cliArgs.template as string);
  if (existsSync(tplPath)) {
    activeTemplate = loadTemplate(tplPath);
    console.log(`Loaded template: ${activeTemplate.name} (${tplPath})`);
  } else {
    // 在模板目录中按名称查找
    const candidates = [`${cliArgs.template}.yaml`, `${cliArgs.template}.yml`, cliArgs.template as string];
    for (const c of candidates) {
      const fp = join(templatesDir, c);
      if (existsSync(fp)) { activeTemplate = loadTemplate(fp); break; }
    }
    if (activeTemplate) console.log(`Loaded template: ${activeTemplate.name}`);
    else console.warn(`Template not found: ${cliArgs.template}`);
  }
} else {
  // 尝试从 state 文件恢复模板名
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    if (saved._template_name) {
      const fp = join(templatesDir, `${saved._template_name}.yaml`);
      if (existsSync(fp)) activeTemplate = loadTemplate(fp);
    }
  } catch {}
}

// 生成 Agent 文件
if (cliArgs["generate-agents"] && activeTemplate) {
  const agentsDir = (cliArgs["agents-dir"] as string) ?? ".cursor/agents";
  generateAllAgents(activeTemplate, agentsDir);
  console.log(`Generated ${Object.keys(activeTemplate.agents).length} agent files in ${agentsDir}/`);
}

// ─── 阶段定义（从模板或默认） ───
const STAGE_DEFS: TemplateStageDef[] = activeTemplate?.stages ?? [
  { name: "explore", label: "Explorer", parallel: false, gate: false, optional: true },
  { name: "propose", label: "Propose", parallel: false, gate: false, optional: false },
  { name: "review", label: "Review", parallel: false, gate: false, optional: false },
  { name: "gate1", label: "Gate 1", parallel: false, gate: true, optional: false },
  { name: "implement", label: "BE ∥ FE", parallel: true, gate: false, optional: false },
  { name: "code-review", label: "Code Review", parallel: true, gate: false, optional: false },
  { name: "gate2", label: "Gate 2", parallel: false, gate: true, optional: false },
  { name: "qa-test", label: "QA Test", parallel: false, gate: false, optional: false },
  { name: "gate3", label: "Gate 3", parallel: false, gate: true, optional: false },
  { name: "integration-test", label: "Int. Test", parallel: false, gate: false, optional: false },
  { name: "archive", label: "Archive", parallel: false, gate: false, optional: false },
];

// ─── 类型 ───
interface Stage {
  name: string;
  status: "pending" | "active" | "completed" | "failed" | "skipped";
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
}

interface ActiveAgent {
  id: string;
  type: string;
  task: string;
  started_at: string;
}

interface CompletedAgent {
  type: string;
  status: "completed" | "error" | "aborted";
  duration: string;
  duration_ms: number;
  completed_at: string;
  summary?: string;
}

interface GateRecord {
  name: string;
  result: "pending" | "passed" | "failed";
  decided_at?: string;
}

interface PipelineState {
  _template_name?: string;
  change_name: string;
  current_stage: string;
  started_at?: string;
  last_checkpoint?: string;
  last_status?: string;
  stages: Stage[];
  active_agents: ActiveAgent[];
  completed_agents: CompletedAgent[];
  gates: GateRecord[];
}

interface HookEvent {
  hook_event_name?: string;
  conversation_id?: string;
  subagent_id?: string;
  subagent_type?: string;
  task?: string;
  status?: string;
  duration_ms?: number;
  summary?: string;
  command?: string;
  [key: string]: unknown;
}

// ─── 状态管理 ───
function newState(): PipelineState {
  const gates = STAGE_DEFS.filter(d => d.gate).map(d => ({ name: d.name, result: "pending" as const }));
  return {
    _template_name: activeTemplate?.name,
    change_name: "",
    current_stage: "",
    stages: STAGE_DEFS.map(d => ({ name: d.name, status: "pending" as const })),
    active_agents: [],
    completed_agents: [],
    gates,
  };
}

let state: PipelineState = loadState() ?? newState();
const wsClients = new Set<any>();

function loadState(): PipelineState | null {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function saveState() {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function broadcast(type: string, data: unknown) {
  const msg = JSON.stringify({ type, data });
  for (const ws of wsClients) {
    try { ws.send(msg); } catch { wsClients.delete(ws); }
  }
}

function appendAudit(event: string, agentType?: string, detail?: string) {
  const entry = { timestamp: new Date().toISOString(), event, agent_type: agentType ?? "", detail: detail ?? "" };
  appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n");
}

function readRecentAudit(limit = 20): object[] {
  try {
    const lines = readFileSync(AUDIT_FILE, "utf-8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

function readExplorerConclusion(): string {
  try { return readFileSync(EXPLORER_FILE, "utf-8").slice(0, 500); } catch { return ""; }
}

// ─── Agent 标识提取 ───
// Cursor 的 subagent_type 只有 generalPurpose/explore/shell 等固定值，
// 但 task/description 文本中通常包含有意义的 agent 角色名。
function extractAgentLabel(subagentType: string, taskText: string, descText: string): string {
  const text = [taskText, descText].join(" ").toLowerCase();

  // 从模板 agent 名称列表中匹配
  if (activeTemplate) {
    for (const name of Object.keys(activeTemplate.agents)) {
      if (text.includes(name)) return name;
    }
  }

  // 从文本中提取常见 agent 角色关键词
  if (/backend.?implement|后端.?实现/i.test(text)) return "backend-implementer";
  if (/frontend.?implement|前端.?实现/i.test(text)) return "frontend-implementer";
  if (/backend.?review|后端.?审查/i.test(text)) return "backend-reviewer";
  if (/frontend.?review|前端.?审查/i.test(text)) return "frontend-reviewer";
  if (/code.?review|代码.?审查/i.test(text)) return "code-reviewer";
  if (/qa.?test|e2e|playwright|功能.?验收/i.test(text)) return "qa-tester";
  if (/integration.?test|集成.?测试/i.test(text)) return "test-writer";
  if (/review|审查/i.test(text)) return "reviewer";
  if (/implement|实现/i.test(text)) return "implementer";

  // 降级为 Cursor 原始类型
  return subagentType || "unknown";
}

// ─── 阶段推断 ───
// Cursor Hook 的 subagent_type 是固定枚举（generalPurpose/explore/shell），
// 不会透传用户在 Task 工具中指定的自定义类型。
// 因此优先从 task/description 文本中提取阶段信息，subagent_type 仅做最终 fallback。
// 推荐 orchestrator 使用主动上报 API 而非依赖此推断。

function inferStage(agentType: string, taskText?: string, description?: string): string {
  const searchText = [taskText ?? "", description ?? "", agentType].join(" ").toLowerCase();

  // 1. 模板精确匹配：在文本中搜索 agent 名称
  if (activeTemplate) {
    for (const s of activeTemplate.raw.stages ?? []) {
      if (s.agent && searchText.includes(s.agent)) return s.name;
      if (Array.isArray(s.parallel)) {
        for (const p of s.parallel) {
          if (p.agent && searchText.includes(p.agent)) return s.name;
        }
      }
    }
  }

  // 2. 关键词匹配（从 task/description 文本中推断）
  if (/\bexplor/i.test(searchText) && agentType === "explore") return "explore";
  if (/\b(backend.?implement|implement.?backend|后端.?实现)/i.test(searchText)) return "implement";
  if (/\b(frontend.?implement|implement.?frontend|前端.?实现)/i.test(searchText)) return "implement";
  if (/\bimplement/i.test(searchText) && agentType !== "explore") return "implement";
  if (/\b(code.?review|backend.?review|frontend.?review|代码.?审查)/i.test(searchText)) return "code-review";
  if (/\breview/i.test(searchText) && !/code.?review/i.test(searchText)) return "review";
  if (/\b(qa.?test|e2e.?test|playwright|功能.?验收)/i.test(searchText)) return "qa-test";
  if (/\b(integration.?test|集成.?测试|test.?writ)/i.test(searchText)) return "integration-test";

  return "";
}

function setStageStatus(name: string, status: Stage["status"], startedAt?: string) {
  const s = state.stages.find(s => s.name === name);
  if (!s) return;
  s.status = status;
  if (startedAt && !s.started_at) s.started_at = startedAt;
}

function setStageCompleted(name: string, completedAt: string) {
  const s = state.stages.find(s => s.name === name);
  if (!s) return;
  s.completed_at = completedAt;
  if (s.started_at) s.duration_ms = new Date(completedAt).getTime() - new Date(s.started_at).getTime();
}

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  return sec > 60 ? `${Math.floor(sec / 60)}m${sec % 60}s` : `${sec}s`;
}

// ─── 事件处理 ───
function handleHookEvent(event: HookEvent): object {
  const now = new Date().toISOString();
  appendAudit(event.hook_event_name ?? "unknown", event.subagent_type, event.task?.slice(0, 100));

  switch (event.hook_event_name) {
    case "sessionStart": {
      const ctx = [];
      if (state.change_name && state.current_stage) {
        ctx.push(`[流水线恢复] 有活跃的 change: ${state.change_name}，当前在 ${state.current_stage} 阶段。`);
      }
      const explorer = readExplorerConclusion();
      if (explorer) ctx.push(`[Explorer 结论] ${explorer}`);
      if (activeTemplate) ctx.push(`[模板] ${activeTemplate.name}: ${activeTemplate.description}`);
      return {
        additional_context: ctx.join(" "),
        env: { PIPELINE_SERVER: `http://127.0.0.1:${PORT}`, PIPELINE_TEMPLATE: activeTemplate?.name ?? "" },
      };
    }

    case "subagentStart": {
      const taskText = (event.task ?? "") as string;
      const descText = (event.description ?? "") as string;
      // 从 task/description 中提取有意义的 agent 标识
      const agentLabel = extractAgentLabel(event.subagent_type ?? "", taskText, descText);

      state.active_agents.push({
        id: event.subagent_id ?? "",
        type: agentLabel,
        task: taskText.slice(0, 100),
        started_at: now,
      });
      const stage = inferStage(event.subagent_type ?? "", taskText, descText);
      if (stage) {
        // 仅在阶段尚未被主动标记为 active 时才被动设置
        const existingStage = state.stages.find(s => s.name === stage);
        if (existingStage && existingStage.status === "pending") {
          state.current_stage = stage;
          setStageStatus(stage, "active", now);
        }
      }
      if (!state.started_at) state.started_at = now;
      saveState();
      broadcast("agent_started", { type: agentLabel, task: taskText });
      return {};
    }

    case "subagentStop": {
      const taskText = (event.task ?? "") as string;
      const descText = (event.description ?? "") as string;
      const agentLabel = extractAgentLabel(event.subagent_type ?? "", taskText, descText);

      // 按 subagent_id 精确移除，避免误删同类型 Agent
      const agentId = event.subagent_id ?? "";
      if (agentId) {
        state.active_agents = state.active_agents.filter(a => a.id !== agentId);
      } else {
        state.active_agents = state.active_agents.filter(a => a.type !== agentLabel);
      }

      const agentStatus = event.status === "completed" ? "completed" : "error";
      state.completed_agents.push({
        type: agentLabel,
        status: agentStatus as any,
        duration: formatDuration(event.duration_ms ?? 0),
        duration_ms: event.duration_ms ?? 0,
        completed_at: now,
        summary: (event.summary ?? "").slice(0, 200),
      });

      const stage = inferStage(event.subagent_type ?? "", taskText, descText);
      if (stage) {
        // 检查同阶段是否还有活跃 Agent
        const stillActive = state.active_agents.some(a => {
          return inferStage("", a.task, "") === stage;
        });
        if (!stillActive) {
          const existingStage = state.stages.find(s => s.name === stage);
          // 仅在阶段处于 active 状态时才被动标记完成（避免覆盖主动上报）
          if (existingStage && existingStage.status === "active") {
            setStageStatus(stage, agentStatus === "error" ? "failed" : "completed");
            setStageCompleted(stage, now);
          }
        }
      }
      saveState();
      broadcast("agent_stopped", { type: agentLabel, status: agentStatus });
      return {};
    }

    case "beforeShellExecution": {
      const cmd = event.command ?? "";
      if (/git\s+push\s+.*(-f|--force)/.test(cmd)) {
        return {
          continue: true, permission: "deny",
          user_message: "Force push 已被拦截。如确需执行，请手动在终端操作。",
          agent_message: "Force push 被安全策略拦截。请告知用户需要手动执行。",
        };
      }
      if (/git\s+reset\s+--hard/.test(cmd)) {
        return { continue: true, permission: "ask", user_message: "git reset --hard 会丢失未提交的变更，是否继续？" };
      }
      if (/kubectl\s+apply.*prod|docker\s+push/.test(cmd)) {
        return { continue: true, permission: "ask", user_message: "检测到生产环境操作，请确认是否继续。" };
      }
      return { continue: true, permission: "allow" };
    }

    case "stop": {
      state.last_checkpoint = now;
      state.last_status = event.status;
      saveState();
      broadcast("pipeline_checkpoint", state);
      return {};
    }

    default:
      return {};
  }
}

// ─── 看板 HTML ───
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><title>Pipeline Dashboard</title>
<style>
:root{--bg:#0f172a;--bg2:#1e293b;--bg3:#334155;--t1:#f8fafc;--t2:#e2e8f0;--tm:#94a3b8;--td:#64748b;--blue:#38bdf8;--green:#34d399;--yellow:#fbbf24;--red:#f87171;--purple:#a78bfa}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--t2);min-height:100vh}
.c{max-width:1200px;margin:0 auto;padding:24px}
.hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px;padding-bottom:16px;border-bottom:1px solid var(--bg2)}
.hdr h1{font-size:20px;font-weight:600;color:var(--t1)}
.meta{font-size:13px;color:var(--td);margin-top:4px}
.cn{color:var(--blue);font-weight:500}
.tpl{color:var(--purple);font-size:12px;margin-top:2px}
.ws{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--td)}
.dot{width:8px;height:8px;border-radius:50%}
.dot-on{background:var(--green)}.dot-off{background:var(--red)}
.badge{display:inline-block;padding:4px 14px;border-radius:9999px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.badge-a{background:#1e3a5f;color:var(--blue)}.badge-i{background:var(--bg2);color:var(--td)}
.pipe{display:flex;gap:6px;align-items:center;margin-bottom:28px;flex-wrap:wrap;padding:16px;background:var(--bg2);border-radius:12px}
.arr{color:var(--bg3);font-size:16px;user-select:none}
.nd{padding:10px 14px;border-radius:8px;font-size:13px;font-weight:500;white-space:nowrap;transition:all .3s}
.p-pending{background:var(--bg);color:var(--td)}
.p-active{background:#1e3a5f;color:var(--blue);box-shadow:0 0 16px rgba(56,189,248,.12);animation:pulse 2s ease-in-out infinite}
.p-done{background:#064e3b;color:var(--green)}
.p-fail{background:#451a1a;color:var(--red)}
.p-gate{background:var(--bg);color:var(--yellow);border:1px dashed var(--yellow);font-size:11px}
.gate-passed{border-color:var(--green)!important;color:var(--green)!important}
.gate-failed{border-color:var(--red)!important;color:var(--red)!important}
.ptag{font-size:9px;color:var(--purple);background:rgba(167,139,250,.1);padding:1px 6px;border-radius:4px;margin-left:4px;vertical-align:top}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.7}}
.panels{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}
.panel{background:var(--bg2);border-radius:10px;padding:16px}
.panel h3{font-size:12px;color:var(--tm);margin-bottom:12px;text-transform:uppercase;letter-spacing:.08em}
.row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--bg)}
.row:last-child{border-bottom:none}
.an{font-size:13px;font-weight:500}.at{font-size:11px;color:var(--td);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{font-size:11px;padding:2px 8px;border-radius:4px}
.t-run{background:#1e3a5f;color:var(--blue)}.t-done{background:#064e3b;color:var(--green)}.t-err{background:#451a1a;color:var(--red)}
.dur{font-size:12px;color:var(--td);margin-left:8px}
.empty{color:var(--td);font-size:13px;font-style:italic;padding:8px 0}
.audit{background:var(--bg2);border-radius:10px;padding:16px}
.audit h3{font-size:12px;color:var(--tm);margin-bottom:12px;text-transform:uppercase;letter-spacing:.08em}
.alog{max-height:240px;overflow-y:auto}
.ae{font-size:12px;padding:4px 0;display:flex;gap:12px;font-family:'JetBrains Mono','Fira Code','Cascadia Code',monospace}
.ae-t{color:var(--td);flex-shrink:0}.ae-e{color:var(--t2)}.ae-a{color:var(--purple)}
@media(max-width:768px){.panels{grid-template-columns:1fr}.pipe{gap:4px}.nd{padding:8px 10px;font-size:11px}}
</style>
</head>
<body>
<div class="c">
<div class="hdr"><div><h1>Pipeline Dashboard</h1><div class="meta">Change: <span class="cn" id="cn">-</span></div><div class="tpl" id="tpl"></div></div>
<div style="text-align:right"><span class="badge badge-i" id="sb">idle</span><div class="ws" style="margin-top:8px"><span class="dot dot-off" id="wd"></span><span id="wl">Connecting...</span></div></div></div>
<div class="pipe" id="pb"></div>
<div class="panels"><div class="panel"><h3>Active Agents</h3><div id="aa"><div class="empty">No active agents</div></div></div>
<div class="panel"><h3>Completed Agents</h3><div id="ca"><div class="empty">No completed agents yet</div></div></div></div>
<div class="audit"><h3>Recent Events</h3><div class="alog" id="al"><div class="empty">No events yet</div></div></div>
</div>
<script>
const B=window.location.origin;
let SD=null,ws,rt;
function cws(){ws=new WebSocket('ws://'+location.host+'/ws');
ws.onopen=()=>{document.getElementById('wd').className='dot dot-on';document.getElementById('wl').textContent='Connected';clearTimeout(rt)};
ws.onclose=()=>{document.getElementById('wd').className='dot dot-off';document.getElementById('wl').textContent='Reconnecting...';rt=setTimeout(cws,3000)};
ws.onmessage=()=>fs()}
async function fs(){try{const[sr,ar,stg]=await Promise.all([fetch(B+'/api/v1/pipeline/state'),fetch(B+'/api/v1/pipeline/audit?limit=20'),fetch(B+'/api/v1/pipeline/stages')]);
SD=await stg.json();rs(await sr.json());ra(await ar.json())}catch{}}
function rs(s){document.getElementById('cn').textContent=s.change_name||'-';
const te=document.getElementById('tpl');te.textContent=s._template_name?'Template: '+s._template_name:'';
const b=document.getElementById('sb'),st=s.current_stage||'idle';b.textContent=st;b.className='badge '+(st==='idle'||!st?'badge-i':'badge-a');
if(!SD)return;
const sm={},gm={};(s.stages||[]).forEach(x=>sm[x.name]=x);(s.gates||[]).forEach(x=>gm[x.name]=x);
let h='';SD.forEach((d,i)=>{if(i)h+='<span class="arr">→</span>';const ss=sm[d.name],st2=ss?ss.status:'pending';
if(d.gate){const g=gm[d.name],gr=g?g.result:'pending';let c='nd p-gate';if(gr==='passed')c+=' gate-passed';else if(gr==='failed')c+=' gate-failed';
h+='<span class="'+c+'">'+d.label+'</span>'}else{let c='nd p-'+st2,ex=d.parallel?'<span class="ptag">∥</span>':'',du='';
if(ss&&ss.duration_ms>0)du=' <span style="font-size:10px;color:var(--td)">'+Math.round(ss.duration_ms/1000)+'s</span>';
h+='<span class="'+c+'">'+d.label+ex+du+'</span>'}});document.getElementById('pb').innerHTML=h;
const ae=document.getElementById('aa');if(!s.active_agents||!s.active_agents.length)ae.innerHTML='<div class="empty">No active agents</div>';
else ae.innerHTML=s.active_agents.map(a=>'<div class="row"><div><div class="an">'+a.type+'</div><div class="at" title="'+(a.task||'')+'">'+(a.task||'')+'</div></div><span class="tag t-run">running</span></div>').join('');
const ce=document.getElementById('ca');if(!s.completed_agents||!s.completed_agents.length)ce.innerHTML='<div class="empty">No completed agents yet</div>';
else ce.innerHTML=s.completed_agents.map(a=>{const tc=a.status==='completed'||a.status==='done'?'t-done':'t-err',lb=a.status==='completed'||a.status==='done'?'done':a.status;
return'<div class="row"><div class="an">'+a.type+'</div><div><span class="tag '+tc+'">'+lb+'</span><span class="dur">'+(a.duration||'')+'</span></div></div>'}).join('')}
function ra(e){const el=document.getElementById('al');if(!e||!e.length){el.innerHTML='<div class="empty">No events yet</div>';return}
el.innerHTML=e.reverse().map(x=>{const t=x.timestamp?new Date(x.timestamp).toLocaleTimeString('zh-CN'):'',ag=x.agent_type?'<span class="ae-a">'+x.agent_type+'</span>':'';
return'<div class="ae"><span class="ae-t">'+t+'</span><span class="ae-e">'+x.event+'</span>'+ag+'</div>'}).join('')}
cws();fs();setInterval(fs,5000);
</script>
</body></html>`;

// ─── HTTP Server ───
const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",

  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    if (url.pathname === "/" || url.pathname === "/dashboard") {
      return new Response(DASHBOARD_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/healthz") {
      return Response.json({ status: "ok", template: activeTemplate?.name ?? null });
    }

    if (url.pathname === "/api/v1/pipeline/hook" && req.method === "POST") {
      return req.json().then((body: HookEvent) => {
        const resp = handleHookEvent(body);
        return Response.json(resp);
      }).catch(() => Response.json({}));
    }

    if (url.pathname === "/api/v1/pipeline/state" && req.method === "GET") {
      return Response.json(state);
    }

    if (url.pathname === "/api/v1/pipeline/stages" && req.method === "GET") {
      return Response.json(STAGE_DEFS);
    }

    if (url.pathname === "/api/v1/pipeline/template" && req.method === "GET") {
      if (!activeTemplate) return Response.json({ error: "no template loaded" }, { status: 404 });
      return Response.json({ name: activeTemplate.name, description: activeTemplate.description, variables: activeTemplate.variables, stages: STAGE_DEFS, agents: Object.keys(activeTemplate.agents) });
    }

    if (url.pathname === "/api/v1/pipeline/templates" && req.method === "GET") {
      const files = listTemplates(templatesDir);
      const templates = files.map(f => {
        try {
          const t = loadTemplate(join(templatesDir, f));
          return { name: t.name, description: t.description, file: f };
        } catch { return { name: f, description: "", file: f }; }
      });
      return Response.json(templates);
    }

    if (url.pathname === "/api/v1/pipeline/audit" && req.method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") ?? "20") || 20;
      return Response.json(readRecentAudit(limit));
    }

    if (url.pathname === "/api/v1/pipeline/reset" && req.method === "POST") {
      state = newState();
      saveState();
      broadcast("pipeline_reset", state);
      return Response.json({ status: "reset" });
    }

    // ─── 主动上报 API（解决 Hook 被动推断不全的问题） ───

    // 设置 change 名称
    if (url.pathname === "/api/v1/pipeline/change" && req.method === "POST") {
      return req.json().then((body: { name: string }) => {
        state.change_name = body.name ?? "";
        if (!state.started_at) state.started_at = new Date().toISOString();
        saveState();
        broadcast("change_updated", { name: state.change_name });
        appendAudit("change_set", "", state.change_name);
        return Response.json({ status: "ok", change_name: state.change_name });
      }).catch(() => Response.json({ error: "invalid body" }, { status: 400 }));
    }

    // 主动推进阶段状态
    // POST { stage: "propose", status: "active" | "completed" | "failed" | "skipped" }
    if (url.pathname === "/api/v1/pipeline/stage" && req.method === "POST") {
      return req.json().then((body: { stage: string; status: string }) => {
        const now = new Date().toISOString();
        const validStatus = ["active", "completed", "failed", "skipped"] as const;
        if (!body.stage || !validStatus.includes(body.status as any)) {
          return Response.json({ error: "invalid stage or status" }, { status: 400 });
        }
        const s = state.stages.find(s => s.name === body.stage);
        if (!s) return Response.json({ error: "stage not found" }, { status: 404 });

        s.status = body.status as any;
        if (body.status === "active") {
          if (!s.started_at) s.started_at = now;
          state.current_stage = body.stage;
        }
        if (body.status === "completed" || body.status === "failed") {
          s.completed_at = now;
          if (s.started_at) s.duration_ms = new Date(now).getTime() - new Date(s.started_at).getTime();
        }
        saveState();
        broadcast("stage_updated", { stage: body.stage, status: body.status });
        appendAudit("stage_" + body.status, "", body.stage);
        return Response.json({ status: "ok", stage: body.stage, new_status: body.status });
      }).catch(() => Response.json({ error: "invalid body" }, { status: 400 }));
    }

    // 更新 Gate 结果
    // POST { gate: "gate1", result: "passed" | "failed" }
    if (url.pathname === "/api/v1/pipeline/gate" && req.method === "POST") {
      return req.json().then((body: { gate: string; result: string }) => {
        const now = new Date().toISOString();
        const g = state.gates.find(g => g.name === body.gate);
        if (!g) return Response.json({ error: "gate not found" }, { status: 404 });
        if (body.result !== "passed" && body.result !== "failed") {
          return Response.json({ error: "result must be 'passed' or 'failed'" }, { status: 400 });
        }
        g.result = body.result;
        g.decided_at = now;
        // 同步更新对应的 stage 状态
        const stageDef = state.stages.find(s => s.name === body.gate);
        if (stageDef) {
          stageDef.status = body.result === "passed" ? "completed" : "failed";
          stageDef.completed_at = now;
        }
        saveState();
        broadcast("gate_decided", { gate: body.gate, result: body.result });
        appendAudit("gate_" + body.result, "", body.gate);
        return Response.json({ status: "ok", gate: body.gate, result: body.result });
      }).catch(() => Response.json({ error: "invalid body" }, { status: 400 }));
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(ws) { wsClients.add(ws); },
    close(ws) { wsClients.delete(ws); },
    message() {},
  },
});

console.log(`Pipeline server: http://127.0.0.1:${PORT}/`);
console.log(`Template:        ${activeTemplate?.name ?? "(default)"}`);
console.log(`Hook endpoint:   http://127.0.0.1:${PORT}/api/v1/pipeline/hook`);
console.log(`Templates dir:   ${templatesDir}`);
