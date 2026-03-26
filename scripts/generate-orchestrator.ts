/**
 * 从 YAML 编排模板确定性生成 orchestrator.md
 *
 * 用法: bun run generate-orchestrator.ts <template.yaml> [output-dir]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseYaml, replaceVars } from "./yaml-parser.ts";

// ─── 类型 ───

interface StageDef {
  name: string;
  label: string;
  agent?: string;
  skill?: string;
  gate?: boolean;
  gate_description?: string;
  optional?: boolean;
  parallel?: { agent: string; scope: string }[];
}

interface Template {
  name: string;
  description: string;
  variables: Record<string, string>;
  stages: StageDef[];
}

// ─── 模板解析 ───

function loadTemplate(filePath: string): Template {
  const content = readFileSync(filePath, "utf-8");
  const raw = parseYaml(content);
  return {
    name: raw.name ?? "",
    description: raw.description ?? "",
    variables: raw.variables ?? {},
    stages: (raw.stages ?? []) as StageDef[],
  };
}

// ─── 判断是否有并行阶段 ───

function hasParallel(stages: StageDef[]): boolean {
  return stages.some(s => Array.isArray(s.parallel) && s.parallel.length > 0);
}

// ─── 收集所有引用的 agent 名称 ───

function collectAgentRefs(stages: StageDef[]): string[] {
  const refs = new Set<string>();
  for (const s of stages) {
    if (s.agent) refs.add(s.agent);
    if (s.parallel) {
      for (const p of s.parallel) refs.add(p.agent);
    }
  }
  return [...refs];
}

// ─── 生成流程图字符串 ───

function buildFlowLine(stages: StageDef[]): string {
  return stages.map(s => {
    const lbl = s.label ?? s.name;
    if (s.gate) return `[${lbl}]`;
    if (s.parallel) {
      const agents = s.parallel.map(p => (p.agent ?? "").split("-").map(w => w[0]?.toUpperCase()).join("")).join(" ∥ ");
      return `${lbl}(${agents})`;
    }
    return lbl;
  }).join(" → ");
}

// ─── 生成阶段总览表格 ───

function buildStageTable(stages: StageDef[]): string {
  const rows = stages.map(s => {
    const lbl = s.label ?? s.name;
    let executor = "";
    let parallel = "";
    if (s.gate) {
      executor = "用户确认";
    } else if (s.skill) {
      executor = `Skill: ${s.skill}`;
    } else if (s.parallel) {
      executor = s.parallel.map(p => p.agent ?? "").join(", ");
      parallel = "是";
    } else if (s.agent) {
      executor = `SubAgent: ${s.agent}`;
    }
    const opt = s.optional ? "（可选）" : "";
    return `| ${s.name} | ${lbl} | ${executor} | ${parallel} | ${opt} |`;
  });

  return [
    "| 阶段 | 标签 | 执行者 | 并行 | 备注 |",
    "|------|------|--------|------|------|",
    ...rows,
  ].join("\n");
}

// ─── 生成单个阶段的工作流程 ───

function buildStageSection(s: StageDef, vars: Record<string, string>, _pid: string): string {
  const lines: string[] = [];
  const label = replaceVars(s.label ?? s.name, vars);
  const pipelineParam = `"pipeline": "<pipeline-id>", `;

  if (s.gate) {
    const desc = s.gate_description ?? s.label;
    lines.push(`### ${s.name}：${desc}`);
    lines.push("");
    lines.push("向用户展示上一阶段的结论摘要，然后呈现选项：");
    lines.push("");
    lines.push("```");
    lines.push(`## ${label}：${desc}`);
    lines.push("");
    lines.push("<上一阶段的结论/报告摘要>");
    lines.push("");
    lines.push("**选项：**");
    lines.push("1. 通过，继续下一步");
    lines.push("2. 需要修改");
    lines.push("3. 跳过 / 放弃");
    lines.push("```");
    lines.push("");
    lines.push("用户确认后上报 Gate 结果：");
    lines.push("```bash");
    lines.push(`curl -s -X POST http://127.0.0.1:19090/api/v1/pipeline/gate \\`);
    lines.push(`  -H "Content-Type: application/json" \\`);
    lines.push(`  -d '{${pipelineParam}"gate": "${s.name}", "result": "passed"}'`);
    lines.push("```");
    return lines.join("\n");
  }

  if (s.skill) {
    lines.push(`### ${s.name}：${label}`);
    lines.push("");
    lines.push("Hook 无法感知 Skill 调用，必须手动上报阶段状态。");
    lines.push("");
    lines.push("```bash");
    lines.push(`# 标记阶段开始`);
    lines.push(`curl -s -X POST http://127.0.0.1:19090/api/v1/pipeline/stage \\`);
    lines.push(`  -H "Content-Type: application/json" \\`);
    lines.push(`  -d '{${pipelineParam}"stage": "${s.name}", "status": "active"}'`);
    lines.push("```");
    lines.push("");
    lines.push(`调用 Skill \`${s.skill}\`。`);
    lines.push("");
    lines.push("```bash");
    lines.push(`# 标记阶段完成`);
    lines.push(`curl -s -X POST http://127.0.0.1:19090/api/v1/pipeline/stage \\`);
    lines.push(`  -H "Content-Type: application/json" \\`);
    lines.push(`  -d '{${pipelineParam}"stage": "${s.name}", "status": "completed"}'`);
    lines.push("```");
    return lines.join("\n");
  }

  if (s.parallel) {
    lines.push(`### ${s.name}：${label}（并行）`);
    lines.push("");
    lines.push("启动前主动标记阶段：");
    lines.push("```bash");
    lines.push(`curl -s -X POST http://127.0.0.1:19090/api/v1/pipeline/stage \\`);
    lines.push(`  -H "Content-Type: application/json" \\`);
    lines.push(`  -d '{${pipelineParam}"stage": "${s.name}", "status": "active"}'`);
    lines.push("```");
    lines.push("");
    lines.push(`在同一条消息中发起多个 Task 工具调用，并行启动（task 描述中包含 \`[pipeline:<pipeline-id>]\`）：`);
    lines.push("");
    for (const p of s.parallel) {
      const scope = replaceVars(p.scope ?? "", vars);
      lines.push(`- **${p.agent}**：作用域 \`${scope}\``);
    }
    lines.push("");
    lines.push("等待所有并行 SubAgent 完成后，标记阶段完成再进入下一阶段。如果一个失败，另一个的结果仍然保留，只重跑失败的那个。");
    lines.push("");
    lines.push("```bash");
    lines.push(`# 标记阶段完成`);
    lines.push(`curl -s -X POST http://127.0.0.1:19090/api/v1/pipeline/stage \\`);
    lines.push(`  -H "Content-Type: application/json" \\`);
    lines.push(`  -d '{${pipelineParam}"stage": "${s.name}", "status": "completed"}'`);
    lines.push("```");
    return lines.join("\n");
  }

  // 单 Agent 阶段
  lines.push(`### ${s.name}：${label}`);
  lines.push("");
  if (s.optional) lines.push("（可选阶段）");
  lines.push("");
  lines.push(`委托给 SubAgent \`${s.agent}\`（task 描述中包含 \`[pipeline:<pipeline-id>]\`）。`);
  lines.push("");
  lines.push("SubAgent 完成后，标记阶段完成：");
  lines.push("```bash");
  lines.push(`curl -s -X POST http://127.0.0.1:19090/api/v1/pipeline/stage \\`);
  lines.push(`  -H "Content-Type: application/json" \\`);
  lines.push(`  -d '{${pipelineParam}"stage": "${s.name}", "status": "completed"}'`);
  lines.push("```");
  return lines.join("\n");
}

// ─── 生成完整 orchestrator.md ───

function generateOrchestrator(tpl: Template, pipelineId?: string): string {
  const vars = tpl.variables;
  const projectName = vars.project_name ?? tpl.name;
  const stageNames = tpl.stages.filter(s => !s.gate).map(s => s.label).join("、");
  const isParallel = hasParallel(tpl.stages);
  const agentRefs = collectAgentRefs(tpl.stages);
  const orchName = pipelineId ? `orchestrator-${pipelineId}` : `orchestrator-${tpl.name}`;
  const triggerWords = pipelineId
    ? `用户说"启动 ${pipelineId}""${pipelineId} 流水线""编排 ${pipelineId}"时触发`
    : `用户说"开始做""启动流水线""全流程""编排"时触发`;
  const pid = pipelineId ?? tpl.name;

  const parts: string[] = [];

  // 1. Front Matter + 角色定义
  parts.push(`---
name: ${orchName}
description: 开发流水线编排器（${tpl.name}）。协调 ${stageNames} 全流程。${triggerWords}。支持从中断处恢复。必须作为 Skill 由主 Agent 加载（而非 SubAgent），以便通过 Task 工具调度子 Agent。
---

# ${projectName} 开发流水线编排器

加载本 Skill 后，你（主 Agent）将扮演流水线编排器角色。你的职责是**按顺序调度专家 SubAgent 完成一个完整的功能开发周期**。

**关键原则**：你不写代码、不做设计、不做测试——你只编排和协调。所有实际工作通过 **Task 工具** 委托给专家 SubAgent。

引用的 SubAgent：${agentRefs.map(a => `\`${a}\``).join("、")}。

**每个变更创建独立的 pipeline 实例**，ID 格式为 \`${tpl.name}--<change-name>\`（由 server 自动生成）。
**重要**：调度 SubAgent 时，在 task 描述中包含 \`[pipeline:<pipeline-id>]\` 标记（使用实际的 pipeline ID），以便 Hook 正确路由事件。`);

  // 2. 核心原则
  let principles = `
## 核心原则

- **你不写代码、不做设计、不做测试**——你只编排和协调
- **每个阶段委托给对应的专家 SubAgent**
- **在关键 Gate 暂停并汇报，等用户说「可以」再继续**
- **中文沟通**，技术术语保留英文
- **主动上报状态**——每个阶段开始/完成时调用 pipeline-server API 上报，不完全依赖 Hook 被动推断`;

  if (isParallel) {
    principles += `\n- **并行调度**——并行阶段拆为独立的 SubAgent 并行执行`;
  }
  parts.push(principles);

  // 3. Pipeline Server API
  parts.push(`
## Pipeline Server API

pipeline-server 运行在 http://127.0.0.1:19090。

### 创建 / 恢复 Pipeline 实例

启动时**首先**调用此 API。server 会自动生成 \`pipeline_id = ${tpl.name}--<change-name>\`。
如果同名实例已存在（中断恢复场景），返回 \`resumed: true\` 并保留原有状态。

\`\`\`bash
curl -s -X POST http://127.0.0.1:19090/api/v1/pipelines \\
  -H "Content-Type: application/json" \\
  -d '{"template": "${tpl.name}", "change_name": "<change-name>"}'
\`\`\`

响应中 \`id\` 字段即为本次流水线的 **pipeline_id**，后续所有 API 调用和 SubAgent 标记都使用这个 ID。

### 推进阶段状态
\`\`\`bash
curl -s -X POST http://127.0.0.1:19090/api/v1/pipeline/stage \\
  -H "Content-Type: application/json" \\
  -d '{"pipeline": "<pipeline-id>", "stage": "<stage-name>", "status": "active|completed|failed|skipped"}'
\`\`\`

### 更新 Gate 结果
\`\`\`bash
curl -s -X POST http://127.0.0.1:19090/api/v1/pipeline/gate \\
  -H "Content-Type: application/json" \\
  -d '{"pipeline": "<pipeline-id>", "gate": "<gate-name>", "result": "passed|failed"}'
\`\`\`

### 重置流水线
\`\`\`bash
curl -s -X POST http://127.0.0.1:19090/api/v1/pipelines/reset \\
  -H "Content-Type: application/json" \\
  -d '{"id": "<pipeline-id>"}'
\`\`\`

### 查看所有活跃流水线
\`\`\`bash
curl -s http://127.0.0.1:19090/api/v1/pipelines
\`\`\`

**重要**：SubAgent 阶段的 start/stop 由 Hook 自动追踪（通过 \`[pipeline:<pipeline-id>]\` 标记路由），但 Skill 阶段和 Gate 阶段完全依赖主动上报。`);

  // 4. 阶段总览
  parts.push(`
## 流水线阶段总览

\`\`\`
${buildFlowLine(tpl.stages)}
\`\`\`

${buildStageTable(tpl.stages)}`);

  // 5. 工作流程
  parts.push(`
## 工作流程

### 启动时检查

1. 查询已有流水线：\`curl -s http://127.0.0.1:19090/api/v1/pipelines\`，检查是否有未完成的实例
2. 读取 \`.cursor/hooks/state/explorer-conclusion.md\`，检查是否有 explorer 结论
3. 如果都没有——询问用户要做什么
4. 确定 change 名称后，创建 pipeline 实例：
\`\`\`bash
# 创建独立的 pipeline 实例（如果已存在则恢复）
response=$(curl -s -X POST http://127.0.0.1:19090/api/v1/pipelines \\
  -H "Content-Type: application/json" \\
  -d '{"template": "${tpl.name}", "change_name": "<change-name>"}')
# 从 response 中提取 pipeline_id，后续所有操作使用此 ID
\`\`\``);

  for (const s of tpl.stages) {
    parts.push("");
    parts.push(buildStageSection(s, vars, pid));
  }

  // 6. 中断恢复
  parts.push(`
## 中断恢复逻辑

当用户说「继续」或再次调用 orchestrator 时：
1. 查询所有流水线：\`curl -s http://127.0.0.1:19090/api/v1/pipelines\`
2. 列出未完成的实例供用户选择（如只有一个则自动恢复）
3. 用选中实例的 \`pipeline_id\` 调用 \`POST /api/v1/pipelines\`（幂等，\`resumed: true\`），恢复状态
4. 根据 \`current_stage\` 和 \`stages\` 的状态，定位到中断点
5. 告知用户当前恢复点，确认后继续`);

  // 7. 并行调度注意事项
  if (isParallel) {
    parts.push(`
## 并行调度注意事项

- 启动并行 SubAgent 时，在同一条消息中发起多个 Task 工具调用
- 等待所有并行 SubAgent 完成后再进入下一阶段
- 如果一个失败了，另一个的结果仍然保留，只重跑失败的那个`);
  }

  // 8. 跳过与回退
  parts.push(`
## 跳过与回退

用户可以在任何 Gate 处：
- **跳过当前阶段**：说「跳过」
- **回到某个阶段**：说「回到 implement」
- **终止流水线**：说「停」「暂停」，保存状态并退出`);

  // 9. 约束
  parts.push(`
## 约束

- 绝不自己写代码或做设计——所有工作委托给专家 SubAgent
- Gate 处必须暂停——不能自动跳过 Gate，必须等用户确认
- 传递完整上下文——调度 SubAgent 时提供足够的 prompt 上下文
- 汇报进度——每个阶段完成后简要汇报`);

  // 10. 完成总结
  parts.push(`
## 流水线完成

archive 阶段完成后输出总结：

\`\`\`
**Change**: <name>

### 各阶段耗时
| 阶段 | 耗时 | 状态 |
|------|------|------|
| ... | Xs | done |

### 产出物
- OpenSpec: openspec/changes/archive/<date>-<name>/
- 测试: <路径>

### 变更摘要
<从 proposal.md 提取>

### 关键决策
<Gate 处的决策记录>
\`\`\`
`);

  return parts.join("\n");
}

// ─── 主流程 ───

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Usage: bun run generate-orchestrator.ts <template.yaml> [output-dir] [pipeline-id]");
  console.error("  output-dir defaults to .cursor/skills (generates orchestrator-{id}/SKILL.md)");
  process.exit(1);
}

const templatePath = resolve(args[0]);
const baseOutputDir = resolve(args[1] ?? ".cursor/skills");
const pipelineIdArg = args[2];

if (!existsSync(templatePath)) {
  console.error(`Template not found: ${templatePath}`);
  process.exit(1);
}

const tpl = loadTemplate(templatePath);
const pipelineId = pipelineIdArg ?? tpl.name;
const md = generateOrchestrator(tpl, pipelineId);

const skillDir = join(baseOutputDir, `orchestrator-${pipelineId}`);
mkdirSync(skillDir, { recursive: true });
const outPath = join(skillDir, "SKILL.md");
writeFileSync(outPath, md);
console.log(`Generated: ${outPath}`);
console.log(`Pipeline:  ${pipelineId}`);
console.log(`Template:  ${tpl.name}`);
console.log(`Stages:    ${tpl.stages.length}`);
console.log(`Agents:    ${collectAgentRefs(tpl.stages).join(", ")}`);
