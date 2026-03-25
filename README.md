# cursor-pipeline

编排已有 SubAgent 的开发流水线。不创建 Agent，只编排。支持多流水线并行运行。

通过 YAML 模板定义阶段顺序、Gate、并行策略，从模板确定性生成 `orchestrator-{id}.md`，提供 Hooks 集成和实时看板。

## 前置条件

- [Bun](https://bun.sh)、[jq](https://jqlang.github.io/jq/)
- 项目已有 `.cursor/agents/*.md`（SubAgent 定义文件）

## 快速开始

```bash
# 在目标项目目录下运行（-t 模板，-p 流水线 ID）
bash /path/to/cursor-pipeline/scripts/init.sh -t go-react-fullstack -p feature

# 启动看板（一个 server 管理所有流水线）
bun run .cursor/hooks/pipeline-server.ts

# 打开 http://127.0.0.1:19090/
```

## 多流水线

同一项目可创建多条流水线，共享 Agent 但使用不同编排流程：

```bash
# 功能开发（完整流程）
bash init.sh -t go-react-fullstack -p feature

# Bug 修复（精简流程）
bash init.sh -t go-backend-only -p bugfix

# 同一模板、不同需求
bash init.sh -t go-react-fullstack -p feature-auth
bash init.sh -t go-react-fullstack -p feature-payment
```

每条流水线生成独立的 `orchestrator-{id}.md` 和 state 文件，互不干扰。
看板页面支持切换查看不同流水线的进度。

## 内置编排模板

| 模板 | 适用场景 |
|------|---------|
| `go-react-fullstack` | 全栈，前后端并行 |
| `go-backend-only` | 纯后端，顺序执行 |
| `node-fullstack` | Node.js 全栈，前后端并行 |

模板只定义编排逻辑（阶段、Gate、并行），`agent` 字段引用项目中已有的 Agent。

## 工作原理

```
explore → propose → review → [Gate] → implement(BE∥FE) → code-review(BE∥FE) → [Gate] → QA → [Gate] → integration-test → archive
```

- **YAML 模板**定义阶段顺序和 Agent 引用
- **generate-orchestrator.ts** 从 YAML 确定性生成 `orchestrator-{id}.md`
- **Cursor Hooks** 自动捕获 SubAgent 启停事件，通过 `[pipeline:id]` 标记路由到对应流水线
- **pipeline-server** 管理多个流水线实例，提供 REST API 和 WebSocket 实时看板

## 目录结构

```
cursor-pipeline/                        # Skill 目录
├── SKILL.md
├── scripts/
│   ├── init.sh                         ← -t <模板> -p <pipeline-id>
│   ├── generate-orchestrator.ts        ← 生成 orchestrator-{id}.md
│   ├── pipeline-server.ts              ← 多流水线管理
│   └── ...
├── templates/                          ← 内置编排模板
└── references/

.cursor/                                # 用户项目目录（init.sh 生成）
├── pipelines/                          ← 编排模板副本
│   └── go-react-fullstack.yaml
├── agents/
│   ├── orchestrator-feature.md         ← 流水线 orchestrator
│   ├── orchestrator-bugfix.md
│   ├── backend-implementer.md          ← 用户自定义 Agent
│   └── ...
└── hooks/
    ├── state/
    │   ├── pipeline-feature.json       ← 独立 state
    │   ├── pipeline-bugfix.json
    │   └── audit.jsonl
    └── pipeline-server.ts
```
