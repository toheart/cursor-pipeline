# cursor-pipeline

模板驱动的 Cursor AI 开发流水线。通过 YAML 模板定义阶段和 Agent 角色，借助 AI 会话引导用户创建完整的编排器，提供 Hooks 集成和实时看板。

## 触发场景

用户说"初始化流水线""创建流水线""设置开发流水线""pipeline init"，或需要为项目搭建 AI 编排工作流时触发。

## 工作流程

当用户激活此 Skill 后，按以下步骤引导：

### 步骤 1：了解项目

向用户询问以下信息（可从项目文件中推断，减少提问）：

1. **项目名称**
2. **技术栈**（如 Go + React、Node.js + React、纯后端等）
3. **目录结构**（后端目录、前端目录、测试目录）
4. **是否需要前后端并行**编码和审查
5. **测试方式**（是否有浏览器 E2E 测试、集成测试如何运行）
6. **是否使用 OpenSpec** 进行变更管理

尽量通过读取项目文件自动推断（如 `go.mod`、`package.json`、`openspec/` 目录），只对无法推断的部分提问。

### 步骤 2：选择或推荐模板

读取 `<skill-dir>/templates/` 下的内置模板：

| 模板 | 适用场景 |
|------|---------|
| `go-react-fullstack.yaml` | Go + React 全栈，前后端并行 |
| `go-backend-only.yaml` | Go 纯后端，单 Agent 顺序执行 |
| `node-fullstack.yaml` | Node.js + React 全栈，前后端并行 |

根据步骤 1 的信息推荐最合适的模板，或询问用户选择。

如果内置模板不满足需求，告知用户可以基于现有模板自定义（参考 `references/template-format.md`）。

### 步骤 3：执行基础设施初始化

运行 init 脚本搭建 Hooks 基础设施：

```bash
bash <skill-dir>/scripts/init.sh
```

或者如果用户的终端不支持交互式选择，手动执行等效操作：

1. 复制 `scripts/forward-hook.sh` → `.cursor/hooks/forward-hook.sh`
2. 复制 `scripts/auto-format.sh` → `.cursor/hooks/auto-format.sh`
3. 复制 `scripts/pipeline-server.ts` → `.cursor/hooks/pipeline-server.ts`
4. 复制 `scripts/hooks.json.tpl` → `.cursor/hooks.json`（如果不存在）
5. 创建 `.cursor/hooks/state/` 目录
6. 运行 `bun run <skill-dir>/scripts/generate-agents.ts <模板路径> .cursor/agents` 生成 Agent 定义

### 步骤 4：引导创建 orchestrator.md

**这是核心步骤。** `generate-agents.ts` 只生成常规 Agent（implementer / reviewer 等），orchestrator 需要根据项目情况定制。

读取 `<skill-dir>/references/orchestrator-guide.md` 获取编写指南，然后根据以下信息为用户生成 `.cursor/agents/orchestrator.md`：

1. 用户选择的模板（决定阶段和 Agent 列表）
2. 项目实际情况（目录结构、测试方式等）
3. 用户对 Gate 设置的偏好
4. 项目特有的 Skill（如项目自带的 code-review Skill）

生成后展示给用户确认，根据反馈调整。

orchestrator.md 必须包含的内容：
- 角色定义（YAML Front Matter + 核心原则）
- 流水线阶段总览（流程图 + 表格）
- 每个阶段的详细调度指令（传给 SubAgent 的 prompt 要包含什么）
- Gate 交互格式（用户看到的选项）
- 中断恢复逻辑
- 并行调度注意事项（如果有并行阶段）
- 完成总结格式

### 步骤 5：验证和启动

1. 检查生成的文件完整性：
   - `.cursor/hooks.json` — Hook 配置
   - `.cursor/hooks/pipeline-server.ts` — 流水线服务
   - `.cursor/hooks/forward-hook.sh` — 事件转发
   - `.cursor/hooks/auto-format.sh` — 自动格式化
   - `.cursor/agents/orchestrator.md` — 编排器
   - `.cursor/agents/*.md` — 各角色 Agent

2. 启动 pipeline-server 验证：
   ```bash
   bun run .cursor/hooks/pipeline-server.ts -t <模板名>
   ```

3. 告知用户后续使用方式：
   - 看板地址：http://127.0.0.1:19090/
   - 触发编排器：在 Cursor 中说"开始做"或"启动流水线"
   - 单独使用 explorer：说"讨论一下"或"分析一下"

## 内置模板说明

模板使用 YAML 格式，定义 `stages`（阶段）和 `agents`（角色）。
详细格式参考 `references/template-format.md`。

核心概念：
- **stages**: 定义流水线阶段顺序，支持 `parallel`（并行）、`gate`（门禁）、`skill`（调用 Skill）
- **agents**: 定义 Agent 角色，包含 model、system prompt、scope
- **variables**: 模板变量，在 system prompt 中用 `{var}` 引用

## 目录结构

```
cursor-pipeline/
├── SKILL.md                           ← 本文件（AI 会话引导入口）
├── scripts/
│   ├── init.sh                        ← 基础设施初始化脚本
│   ├── generate-agents.ts             ← Agent .md 生成器（不含 orchestrator）
│   ├── pipeline-server.ts             ← 流水线服务（Bun 单文件，模板驱动）
│   ├── forward-hook.sh                ← Hook 事件转发
│   ├── auto-format.sh                 ← 自动格式化
│   └── hooks.json.tpl                 ← hooks.json 模板
├── templates/
│   ├── go-react-fullstack.yaml        ← Go + React 全栈
│   ├── go-backend-only.yaml           ← Go 纯后端
│   └── node-fullstack.yaml            ← Node.js + React 全栈
└── references/
    ├── template-format.md             ← YAML 模板格式说明
    └── orchestrator-guide.md          ← Orchestrator 编写参考指南
```
