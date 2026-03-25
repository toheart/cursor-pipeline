/**
 * Pipeline Server — Cursor Hooks 流水线状态追踪与可视化
 *
 * 支持多流水线并行运行。每个流水线有独立的 state 文件和模板。
 * HTTP API + WebSocket 实时推送 + 看板
 *
 * 启动方式: bun run pipeline-server.ts [--templates-dir <path>] [--pipelines-dir <path>]
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { parseArgs } from "node:util";
import { parseYaml, replaceVars } from "./yaml-parser.ts";

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
  agentRefs: string[];
  raw: any;
}

function collectAgentRefs(rawStages: any[]): string[] {
  const refs = new Set<string>();
  for (const s of rawStages) {
    if (s.agent) refs.add(s.agent);
    if (Array.isArray(s.parallel)) {
      for (const p of s.parallel) {
        if (p.agent) refs.add(p.agent);
      }
    }
  }
  return [...refs];
}

function loadTemplate(filePath: string): TemplateConfig {
  const content = readFileSync(filePath, "utf-8");
  const raw = parseYaml(content);

  const variables = raw.variables ?? {};
  const rawStages = raw.stages ?? [];
  const stages: TemplateStageDef[] = rawStages.map((s: any) => ({
    name: s.name,
    label: replaceVars(s.label ?? s.name, variables),
    parallel: Array.isArray(s.parallel),
    gate: s.gate === true,
    optional: s.optional === true,
  }));
  const agentRefs = collectAgentRefs(rawStages);

  return { name: raw.name, description: raw.description ?? "", variables, stages, agentRefs, raw };
}

function listTemplateFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch { return []; }
}

// ─── 配置 ───
const PORT = 19090;
const DATA_DIR = ".cursor/hooks/state";
const AUDIT_FILE = join(DATA_DIR, "audit.jsonl");
const EXPLORER_FILE = join(DATA_DIR, "explorer-conclusion.md");

mkdirSync(DATA_DIR, { recursive: true });

const { values: cliArgs } = parseArgs({
  options: {
    "templates-dir": { type: "string" },
    "pipelines-dir": { type: "string" },
  },
  strict: false,
});

const BUILTIN_TEMPLATES_DIR = resolve(import.meta.dir, "../templates");
const templatesDir = (cliArgs["templates-dir"] as string) ?? BUILTIN_TEMPLATES_DIR;
const PIPELINES_DIR = (cliArgs["pipelines-dir"] as string) ?? ".cursor/pipelines";
mkdirSync(PIPELINES_DIR, { recursive: true });

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
  pipeline_id: string;
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
  description?: string;
  [key: string]: unknown;
}

// ─── 多 Pipeline 实例管理 ───

interface PipelineInstance {
  id: string;
  template: TemplateConfig;
  stageDefs: TemplateStageDef[];
  state: PipelineState;
  stateFile: string;
}

const pipelines = new Map<string, PipelineInstance>();

function stateFilePath(pipelineId: string): string {
  return join(DATA_DIR, `pipeline-${pipelineId}.json`);
}

function newState(pipelineId: string, template: TemplateConfig, stageDefs: TemplateStageDef[]): PipelineState {
  const gates = stageDefs.filter(d => d.gate).map(d => ({ name: d.name, result: "pending" as const }));
  return {
    pipeline_id: pipelineId,
    _template_name: template.name,
    change_name: "",
    current_stage: "",
    stages: stageDefs.map(d => ({ name: d.name, status: "pending" as const })),
    active_agents: [],
    completed_agents: [],
    gates,
  };
}

function loadPipelineState(filePath: string): PipelineState | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch { return null; }
}

function savePipelineState(inst: PipelineInstance) {
  writeFileSync(inst.stateFile, JSON.stringify(inst.state, null, 2));
}

function findOrLoadTemplate(nameOrPath: string): TemplateConfig | null {
  if (existsSync(nameOrPath)) return loadTemplate(nameOrPath);
  for (const dir of [PIPELINES_DIR, templatesDir]) {
    for (const ext of ["yaml", "yml"]) {
      const fp = join(dir, `${nameOrPath}.${ext}`);
      if (existsSync(fp)) return loadTemplate(fp);
    }
    const fp = join(dir, nameOrPath);
    if (existsSync(fp)) return loadTemplate(fp);
  }
  return null;
}

function loadPipeline(pipelineId: string): PipelineInstance | null {
  if (pipelines.has(pipelineId)) return pipelines.get(pipelineId)!;

  const sf = stateFilePath(pipelineId);
  const saved = loadPipelineState(sf);
  if (!saved) return null;

  const tplName = saved._template_name;
  if (!tplName) return null;

  const template = findOrLoadTemplate(tplName);
  if (!template) return null;

  const stageDefs = template.stages;
  const inst: PipelineInstance = { id: pipelineId, template, stageDefs, state: saved, stateFile: sf };
  pipelines.set(pipelineId, inst);
  return inst;
}

function createPipeline(pipelineId: string, template: TemplateConfig): PipelineInstance {
  const stageDefs = template.stages;
  const sf = stateFilePath(pipelineId);
  const state = newState(pipelineId, template, stageDefs);
  const inst: PipelineInstance = { id: pipelineId, template, stageDefs, state, stateFile: sf };
  pipelines.set(pipelineId, inst);
  savePipelineState(inst);
  return inst;
}

function listPipelines(): PipelineInstance[] {
  // 从 state 文件发现并加载未缓存的 pipeline
  try {
    const files = readdirSync(DATA_DIR).filter(f => f.startsWith("pipeline-") && f.endsWith(".json"));
    for (const f of files) {
      const id = f.replace(/^pipeline-/, "").replace(/\.json$/, "");
      if (!pipelines.has(id)) loadPipeline(id);
    }
  } catch {}
  return [...pipelines.values()];
}

function getActivePipeline(url: URL): PipelineInstance | null {
  const id = url.searchParams.get("pipeline");
  if (!id) {
    const all = listPipelines();
    // 默认返回最近活跃的
    const active = all.filter(p => p.state.current_stage || p.state.started_at);
    if (active.length === 1) return active[0];
    return all[0] ?? null;
  }
  return loadPipeline(id) ?? null;
}

// 启动时加载所有已有 pipeline
listPipelines();

const wsClients = new Set<any>();

function broadcast(type: string, data: unknown) {
  const msg = JSON.stringify({ type, data });
  for (const ws of wsClients) {
    try { ws.send(msg); } catch { wsClients.delete(ws); }
  }
}

function appendAudit(event: string, agentType?: string, detail?: string, pipelineId?: string) {
  const entry = { timestamp: new Date().toISOString(), event, agent_type: agentType ?? "", detail: detail ?? "", pipeline_id: pipelineId ?? "" };
  appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n");
}

function readRecentAudit(limit = 20, pipelineId?: string): object[] {
  try {
    const lines = readFileSync(AUDIT_FILE, "utf-8").trim().split("\n").filter(Boolean);
    let entries = lines.map(l => JSON.parse(l));
    if (pipelineId) entries = entries.filter((e: any) => !e.pipeline_id || e.pipeline_id === pipelineId);
    return entries.slice(-limit);
  } catch { return []; }
}

function readExplorerConclusion(): string {
  try { return readFileSync(EXPLORER_FILE, "utf-8").slice(0, 500); } catch { return ""; }
}

// ─── Agent 标识提取 ───
function extractAgentLabel(subagentType: string, taskText: string, descText: string, template?: TemplateConfig): string {
  const text = [taskText, descText].join(" ").toLowerCase();

  if (template) {
    for (const name of template.agentRefs) {
      if (text.includes(name)) return name;
    }
  }

  if (/backend.?implement|后端.?实现/i.test(text)) return "backend-implementer";
  if (/frontend.?implement|前端.?实现/i.test(text)) return "frontend-implementer";
  if (/backend.?review|后端.?审查/i.test(text)) return "backend-reviewer";
  if (/frontend.?review|前端.?审查/i.test(text)) return "frontend-reviewer";
  if (/code.?review|代码.?审查/i.test(text)) return "code-reviewer";
  if (/qa.?test|e2e|playwright|功能.?验收/i.test(text)) return "qa-tester";
  if (/integration.?test|集成.?测试/i.test(text)) return "test-writer";
  if (/review|审查/i.test(text)) return "reviewer";
  if (/implement|实现/i.test(text)) return "implementer";

  return subagentType || "unknown";
}

// ─── 阶段推断 ───
function inferStage(agentType: string, taskText?: string, description?: string, template?: TemplateConfig): string {
  const searchText = [taskText ?? "", description ?? "", agentType].join(" ").toLowerCase();

  if (template) {
    for (const s of template.raw.stages ?? []) {
      if (s.agent && searchText.includes(s.agent)) return s.name;
      if (Array.isArray(s.parallel)) {
        for (const p of s.parallel) {
          if (p.agent && searchText.includes(p.agent)) return s.name;
        }
      }
    }
  }

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

function setStageStatus(state: PipelineState, name: string, status: Stage["status"], startedAt?: string) {
  const s = state.stages.find(s => s.name === name);
  if (!s) return;
  s.status = status;
  if (startedAt && !s.started_at) s.started_at = startedAt;
}

function setStageCompleted(state: PipelineState, name: string, completedAt: string) {
  const s = state.stages.find(s => s.name === name);
  if (!s) return;
  s.completed_at = completedAt;
  if (s.started_at) s.duration_ms = new Date(completedAt).getTime() - new Date(s.started_at).getTime();
}

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  return sec > 60 ? `${Math.floor(sec / 60)}m${sec % 60}s` : `${sec}s`;
}

// ─── Hook 事件处理 ───
// Hook 事件需要匹配到正确的 pipeline。通过 task/description 中的 pipeline_id 或 agent 名称推断。
function findPipelineForEvent(event: HookEvent): PipelineInstance | null {
  const taskText = (event.task ?? "") as string;
  const descText = (event.description ?? "") as string;
  const searchText = [taskText, descText].join(" ").toLowerCase();

  // 优先从文本中寻找 pipeline_id 标记
  const idMatch = searchText.match(/\[pipeline:([^\]]+)\]/);
  if (idMatch) {
    const inst = loadPipeline(idMatch[1]);
    if (inst) return inst;
  }

  // 按 agent 名称匹配：检查每个 pipeline 的 agentRefs
  const all = listPipelines();
  const candidates: PipelineInstance[] = [];
  for (const inst of all) {
    for (const ref of inst.template.agentRefs) {
      if (searchText.includes(ref)) { candidates.push(inst); break; }
    }
  }
  if (candidates.length === 1) return candidates[0];

  // 返回有活跃阶段的 pipeline
  const active = all.filter(p => p.state.current_stage && p.state.active_agents.length > 0);
  if (active.length === 1) return active[0];

  return all[0] ?? null;
}

function handleHookEvent(event: HookEvent): object {
  const now = new Date().toISOString();

  switch (event.hook_event_name) {
    case "sessionStart": {
      const ctx: string[] = [];
      const all = listPipelines();
      const active = all.filter(p => p.state.current_stage && p.state.change_name);
      if (active.length > 0) {
        ctx.push(`[活跃流水线] ${active.map(p => `${p.id}(${p.state.change_name}@${p.state.current_stage})`).join(", ")}`);
      }
      const explorer = readExplorerConclusion();
      if (explorer) ctx.push(`[Explorer 结论] ${explorer}`);
      const tplNames = all.map(p => p.template.name);
      if (tplNames.length) ctx.push(`[已注册模板] ${tplNames.join(", ")}`);
      appendAudit(event.hook_event_name ?? "unknown", event.subagent_type);
      return {
        additional_context: ctx.join(" "),
        env: { PIPELINE_SERVER: `http://127.0.0.1:${PORT}`, PIPELINE_COUNT: String(all.length) },
      };
    }

    case "subagentStart": {
      const inst = findPipelineForEvent(event);
      if (!inst) { appendAudit("subagentStart", event.subagent_type, "(no pipeline matched)"); return {}; }

      const taskText = (event.task ?? "") as string;
      const descText = (event.description ?? "") as string;
      const agentLabel = extractAgentLabel(event.subagent_type ?? "", taskText, descText, inst.template);
      const { state } = inst;

      state.active_agents.push({
        id: event.subagent_id ?? "",
        type: agentLabel,
        task: taskText.slice(0, 100),
        started_at: now,
      });
      const stage = inferStage(event.subagent_type ?? "", taskText, descText, inst.template);
      if (stage) {
        const existing = state.stages.find(s => s.name === stage);
        if (existing && existing.status === "pending") {
          state.current_stage = stage;
          setStageStatus(state, stage, "active", now);
        }
      }
      if (!state.started_at) state.started_at = now;
      savePipelineState(inst);
      broadcast("agent_started", { pipeline_id: inst.id, type: agentLabel, task: taskText });
      appendAudit("subagentStart", agentLabel, taskText.slice(0, 100), inst.id);
      return {};
    }

    case "subagentStop": {
      const inst = findPipelineForEvent(event);
      if (!inst) { appendAudit("subagentStop", event.subagent_type, "(no pipeline matched)"); return {}; }

      const taskText = (event.task ?? "") as string;
      const descText = (event.description ?? "") as string;
      const agentLabel = extractAgentLabel(event.subagent_type ?? "", taskText, descText, inst.template);
      const { state } = inst;

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

      const stage = inferStage(event.subagent_type ?? "", taskText, descText, inst.template);
      if (stage) {
        const stillActive = state.active_agents.some(a => inferStage("", a.task, "", inst.template) === stage);
        if (!stillActive) {
          const existing = state.stages.find(s => s.name === stage);
          if (existing && existing.status === "active") {
            setStageStatus(state, stage, agentStatus === "error" ? "failed" : "completed");
            setStageCompleted(state, stage, now);
          }
        }
      }
      savePipelineState(inst);
      broadcast("agent_stopped", { pipeline_id: inst.id, type: agentLabel, status: agentStatus });
      appendAudit("subagentStop", agentLabel, taskText.slice(0, 100), inst.id);
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
      for (const inst of pipelines.values()) {
        inst.state.last_checkpoint = now;
        inst.state.last_status = event.status;
        savePipelineState(inst);
      }
      broadcast("pipeline_checkpoint", { pipelines: listPipelines().map(p => p.state) });
      return {};
    }

    default:
      return {};
  }
}

// ─── 看板 HTML ───
const DASHBOARD_CANDIDATES = [
  resolve(import.meta.dir, "assets/dashboard.html"),
  resolve(import.meta.dir, "../assets/dashboard.html"),
];
const DASHBOARD_HTML_PATH = DASHBOARD_CANDIDATES.find(p => existsSync(p)) ?? DASHBOARD_CANDIDATES[0];
const DASHBOARD_HTML = existsSync(DASHBOARD_HTML_PATH)
  ? readFileSync(DASHBOARD_HTML_PATH, "utf-8")
  : "<html><body><h1>Dashboard not found</h1><p>Expected at: " + DASHBOARD_CANDIDATES.join(" or ") + "</p></body></html>";

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
      return Response.json({ status: "ok", pipelines: listPipelines().map(p => ({ id: p.id, template: p.template.name })) });
    }

    if (url.pathname === "/api/v1/pipeline/hook" && req.method === "POST") {
      return req.json().then((body: HookEvent) => {
        const resp = handleHookEvent(body);
        return Response.json(resp);
      }).catch(() => Response.json({}));
    }

    // ─── 多 Pipeline 管理 API ───

    // 列出所有 pipeline
    if (url.pathname === "/api/v1/pipelines" && req.method === "GET") {
      const all = listPipelines();
      return Response.json(all.map(p => ({
        id: p.id,
        template: p.template.name,
        description: p.template.description,
        change_name: p.state.change_name,
        current_stage: p.state.current_stage,
        started_at: p.state.started_at,
        stage_summary: {
          total: p.state.stages.length,
          completed: p.state.stages.filter(s => s.status === "completed").length,
          active: p.state.stages.filter(s => s.status === "active").length,
          failed: p.state.stages.filter(s => s.status === "failed").length,
        },
      })));
    }

    // 创建新 pipeline
    if (url.pathname === "/api/v1/pipelines" && req.method === "POST") {
      return req.json().then((body: { id: string; template: string }) => {
        if (!body.id || !body.template) {
          return Response.json({ error: "id and template are required" }, { status: 400 });
        }
        if (pipelines.has(body.id)) {
          return Response.json({ error: `pipeline '${body.id}' already exists` }, { status: 409 });
        }
        const tpl = findOrLoadTemplate(body.template);
        if (!tpl) {
          return Response.json({ error: `template '${body.template}' not found` }, { status: 404 });
        }
        const inst = createPipeline(body.id, tpl);
        broadcast("pipeline_created", { id: inst.id, template: tpl.name });
        appendAudit("pipeline_created", "", inst.id, inst.id);
        return Response.json({ status: "ok", id: inst.id, template: tpl.name });
      }).catch(() => Response.json({ error: "invalid body" }, { status: 400 }));
    }

    // 删除/重置 pipeline
    if (url.pathname === "/api/v1/pipelines/reset" && req.method === "POST") {
      return req.json().then((body: { id: string }) => {
        const inst = loadPipeline(body.id);
        if (!inst) return Response.json({ error: "pipeline not found" }, { status: 404 });
        inst.state = newState(inst.id, inst.template, inst.stageDefs);
        savePipelineState(inst);
        broadcast("pipeline_reset", { id: inst.id });
        appendAudit("pipeline_reset", "", inst.id, inst.id);
        return Response.json({ status: "reset", id: inst.id });
      }).catch(() => Response.json({ error: "invalid body" }, { status: 400 }));
    }

    // ─── 单 Pipeline 操作 API（通过 ?pipeline=<id> 参数） ───

    if (url.pathname === "/api/v1/pipeline/state" && req.method === "GET") {
      const inst = getActivePipeline(url);
      if (!inst) return Response.json({ error: "no pipeline found" }, { status: 404 });
      return Response.json(inst.state);
    }

    if (url.pathname === "/api/v1/pipeline/stages" && req.method === "GET") {
      const inst = getActivePipeline(url);
      if (!inst) return Response.json({ error: "no pipeline found" }, { status: 404 });
      return Response.json(inst.stageDefs);
    }

    if (url.pathname === "/api/v1/pipeline/template" && req.method === "GET") {
      const inst = getActivePipeline(url);
      if (!inst) return Response.json({ error: "no pipeline found" }, { status: 404 });
      return Response.json({
        name: inst.template.name,
        description: inst.template.description,
        variables: inst.template.variables,
        stages: inst.stageDefs,
        agents: inst.template.agentRefs,
      });
    }

    if (url.pathname === "/api/v1/pipeline/templates" && req.method === "GET") {
      const builtIn = listTemplateFiles(templatesDir);
      const project = listTemplateFiles(PIPELINES_DIR);
      const all = new Map<string, { name: string; description: string; file: string; source: string }>();
      for (const f of builtIn) {
        try {
          const t = loadTemplate(join(templatesDir, f));
          all.set(t.name, { name: t.name, description: t.description, file: f, source: "builtin" });
        } catch { all.set(f, { name: f, description: "", file: f, source: "builtin" }); }
      }
      for (const f of project) {
        try {
          const t = loadTemplate(join(PIPELINES_DIR, f));
          all.set(t.name, { name: t.name, description: t.description, file: f, source: "project" });
        } catch { all.set(f, { name: f, description: "", file: f, source: "project" }); }
      }
      return Response.json([...all.values()]);
    }

    if (url.pathname === "/api/v1/pipeline/audit" && req.method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") ?? "20") || 20;
      const pipelineId = url.searchParams.get("pipeline") ?? undefined;
      return Response.json(readRecentAudit(limit, pipelineId));
    }

    // 兼容旧的单 pipeline reset API
    if (url.pathname === "/api/v1/pipeline/reset" && req.method === "POST") {
      const inst = getActivePipeline(url);
      if (!inst) return Response.json({ error: "no pipeline found" }, { status: 404 });
      inst.state = newState(inst.id, inst.template, inst.stageDefs);
      savePipelineState(inst);
      broadcast("pipeline_reset", { id: inst.id });
      return Response.json({ status: "reset", id: inst.id });
    }

    // 设置 change 名称
    if (url.pathname === "/api/v1/pipeline/change" && req.method === "POST") {
      return req.json().then((body: { name: string; pipeline?: string }) => {
        const id = body.pipeline ?? url.searchParams.get("pipeline");
        let inst: PipelineInstance | null = null;
        if (id) inst = loadPipeline(id);
        if (!inst) inst = getActivePipeline(url);
        if (!inst) return Response.json({ error: "no pipeline found" }, { status: 404 });

        inst.state.change_name = body.name ?? "";
        if (!inst.state.started_at) inst.state.started_at = new Date().toISOString();
        savePipelineState(inst);
        broadcast("change_updated", { pipeline_id: inst.id, name: inst.state.change_name });
        appendAudit("change_set", "", inst.state.change_name, inst.id);
        return Response.json({ status: "ok", pipeline_id: inst.id, change_name: inst.state.change_name });
      }).catch(() => Response.json({ error: "invalid body" }, { status: 400 }));
    }

    // 主动推进阶段状态
    if (url.pathname === "/api/v1/pipeline/stage" && req.method === "POST") {
      return req.json().then((body: { stage: string; status: string; pipeline?: string }) => {
        const id = body.pipeline ?? url.searchParams.get("pipeline");
        let inst: PipelineInstance | null = null;
        if (id) inst = loadPipeline(id);
        if (!inst) inst = getActivePipeline(url);
        if (!inst) return Response.json({ error: "no pipeline found" }, { status: 404 });

        const now = new Date().toISOString();
        const validStatus = ["active", "completed", "failed", "skipped"] as const;
        if (!body.stage || !validStatus.includes(body.status as any)) {
          return Response.json({ error: "invalid stage or status" }, { status: 400 });
        }
        const s = inst.state.stages.find(s => s.name === body.stage);
        if (!s) return Response.json({ error: "stage not found" }, { status: 404 });

        s.status = body.status as any;
        if (body.status === "active") {
          if (!s.started_at) s.started_at = now;
          inst.state.current_stage = body.stage;
        }
        if (body.status === "completed" || body.status === "failed") {
          s.completed_at = now;
          if (s.started_at) s.duration_ms = new Date(now).getTime() - new Date(s.started_at).getTime();
        }
        savePipelineState(inst);
        broadcast("stage_updated", { pipeline_id: inst.id, stage: body.stage, status: body.status });
        appendAudit("stage_" + body.status, "", body.stage, inst.id);
        return Response.json({ status: "ok", pipeline_id: inst.id, stage: body.stage, new_status: body.status });
      }).catch(() => Response.json({ error: "invalid body" }, { status: 400 }));
    }

    // 更新 Gate 结果
    if (url.pathname === "/api/v1/pipeline/gate" && req.method === "POST") {
      return req.json().then((body: { gate: string; result: string; pipeline?: string }) => {
        const id = body.pipeline ?? url.searchParams.get("pipeline");
        let inst: PipelineInstance | null = null;
        if (id) inst = loadPipeline(id);
        if (!inst) inst = getActivePipeline(url);
        if (!inst) return Response.json({ error: "no pipeline found" }, { status: 404 });

        const now = new Date().toISOString();
        const g = inst.state.gates.find(g => g.name === body.gate);
        if (!g) return Response.json({ error: "gate not found" }, { status: 404 });
        if (body.result !== "passed" && body.result !== "failed") {
          return Response.json({ error: "result must be 'passed' or 'failed'" }, { status: 400 });
        }
        g.result = body.result;
        g.decided_at = now;
        const stageDef = inst.state.stages.find(s => s.name === body.gate);
        if (stageDef) {
          stageDef.status = body.result === "passed" ? "completed" : "failed";
          stageDef.completed_at = now;
        }
        savePipelineState(inst);
        broadcast("gate_decided", { pipeline_id: inst.id, gate: body.gate, result: body.result });
        appendAudit("gate_" + body.result, "", body.gate, inst.id);
        return Response.json({ status: "ok", pipeline_id: inst.id, gate: body.gate, result: body.result });
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
console.log(`Templates dir:   ${templatesDir}`);
console.log(`Pipelines dir:   ${PIPELINES_DIR}`);
console.log(`Pipelines:       ${listPipelines().map(p => p.id).join(", ") || "(none)"}`);
console.log(`Hook endpoint:   http://127.0.0.1:${PORT}/api/v1/pipeline/hook`);
