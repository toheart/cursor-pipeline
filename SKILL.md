---
name: cursor-pipeline
description: 编排已有 SubAgent 的开发流水线。通过 YAML 模板定义阶段顺序、Gate、并行策略，从模板确定性生成 orchestrator.md，提供 Hooks 集成和实时看板。支持多流水线并行运行。用户说"初始化流水线""创建流水线""设置编排""pipeline init"，或需要为项目搭建 AI 编排工作流时触发。
---

# cursor-pipeline

编排已有 SubAgent 的开发流水线。不创建 Agent，只编排。支持同一项目运行多条流水线。

**前置依赖**：[Bun](https://bun.sh)、`jq`。

## 工作流程

### 步骤 0：探测已有 Agent

扫描 `.cursor/agents/*.md`。

- **没有 Agent** → 教学模式（见下方）
- **有 Agent** → 展示列表，进入步骤 1

### 步骤 1：讨论编排方案

了解项目（从 `go.mod`、`package.json` 等文件推断技术栈和目录结构），与用户讨论：

1. 这些 Agent 按什么顺序协作？
2. 哪些阶段需要 Gate（用户确认点）？
3. 哪些 Agent 可以并行执行？
4. 是否使用 OpenSpec 进行变更管理？
5. 是否需要多条流水线？（如功能开发 + Bug 修复 + 重构各用不同流程）

用 `<skill-dir>/templates/` 下的内置模板举例帮助用户理解：

| 模板 | 适用场景 |
|------|---------|
| `go-react-fullstack.yaml` | 全栈，前后端并行 |
| `go-backend-only.yaml` | 纯后端，顺序执行 |
| `node-fullstack.yaml` | Node.js 全栈，前后端并行 |

模板格式参考 `references/template-format.md`。

### 步骤 2：产出 YAML 编排模板

基于讨论结果：
- 选择最接近的内置模板并调整，或从零创建自定义 YAML
- 确认 `variables`（项目名、目录路径、端口等）
- stages 中 `agent` 字段必须与 `.cursor/agents/` 下已有的 Agent 名称对应
- 将 YAML 写入 `.cursor/pipelines/` 目录

### 步骤 3：生成 orchestrator + 部署 hooks

运行 init 脚本一步完成：

```bash
bash <skill-dir>/scripts/init.sh -t <模板名> -p <pipeline-id>
```

`-p` 指定 pipeline ID，不同 ID 可复用同一模板创建独立流水线。省略 `-p` 时默认使用模板名作为 ID。

init.sh 执行的操作：
1. 复制 hook 脚本 → `.cursor/hooks/`
2. 复制 `hooks.json.tpl` → `.cursor/hooks.json`（如果不存在）
3. 复制模板到 `.cursor/pipelines/`
4. 运行 `generate-orchestrator.ts` 生成 `.cursor/skills/orchestrator-{pipeline-id}/SKILL.md`
5. 创建 pipeline state 文件 `.cursor/hooks/state/pipeline-{pipeline-id}.json`

### 步骤 4：验证和启动

1. 检查文件完整性（`hooks.json`、`pipeline-server.ts`、`orchestrator-*/SKILL.md`）
2. 启动 pipeline-server：`bun run .cursor/hooks/pipeline-server.ts`
3. 告知用户：看板 http://127.0.0.1:19090/（支持切换查看不同流水线）
4. 使用 orchestrator Skill 的触发词启动对应流水线

### 多流水线示例

同一项目可创建多条流水线，共享 Agent 但使用不同编排流程：

```bash
# 功能开发流水线（完整流程）
bash <skill-dir>/scripts/init.sh -t go-react-fullstack -p feature

# Bug 修复流水线（精简流程，跳过 explore 和 propose）
bash <skill-dir>/scripts/init.sh -t go-backend-only -p bugfix
```

生成的文件：
- `.cursor/skills/orchestrator-feature/SKILL.md` — 触发词"启动 feature"
- `.cursor/skills/orchestrator-bugfix/SKILL.md` — 触发词"启动 bugfix"
- `.cursor/hooks/state/pipeline-feature.json` — feature 流水线状态
- `.cursor/hooks/state/pipeline-bugfix.json` — bugfix 流水线状态

看板页面顶部有流水线选择器，可切换查看不同流水线的进度。

## 教学模式

当项目没有 `.cursor/agents/*.md` 时进入此模式。

目标：帮助用户理解 SubAgent 编排概念，然后引导他先创建 Agent，创建完后回来做编排。

教学要点（用内置模板 `go-react-fullstack.yaml` 举例）：

1. **SubAgent 是什么**：Cursor 中的 `.cursor/agents/*.md` 文件定义了专家角色（如 `backend-implementer`），每个 Agent 有独立的 system prompt 和作用域
2. **编排是什么**：orchestrator 按阶段调度这些 Agent，在关键节点（Gate）暂停等用户确认
3. **并行是什么**：前后端 implementer 可以同时启动，各自在自己的 scope 内工作
4. **Gate 是什么**：用户检查点，决定是否继续、修改还是回退
5. **多流水线**：同一套 Agent 可以用不同的编排模板组成多条流水线，适应不同开发场景

引导用户创建自己的 Agent 后，再次激活此 Skill 即可进入编排流程。

## 目录结构

```
cursor-pipeline/
├── SKILL.md                        ← 本文件
├── agents/openai.yaml              ← UI 元数据
├── scripts/
│   ├── init.sh                     ← 初始化脚本（-t 模板 -p pipeline-id）
│   ├── generate-orchestrator.ts    ← 从 YAML 生成 orchestrator-{id}/SKILL.md
│   ├── pipeline-server.ts          ← 流水线服务（支持多 pipeline 并行）
│   ├── yaml-parser.ts              ← 共享 YAML 解析模块
│   ├── forward-hook.sh             ← Hook 事件转发
│   ├── auto-format.sh              ← 自动格式化
│   └── hooks.json.tpl              ← hooks.json 模板
├── assets/
│   └── dashboard.html              ← 看板 HTML（支持多流水线切换）
├── templates/                      ← YAML 编排模板（纯编排，不含 Agent 定义）
└── references/
    ├── template-format.md          ← 模板格式说明
    └── orchestrator-guide.md       ← Orchestrator 结构参考（开发者文档）
```
