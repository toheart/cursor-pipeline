# Orchestrator 编写指南

本文档是 AI 在引导用户创建 orchestrator.md 时的参考蓝本。AI 应根据用户选择的模板和项目实际情况，定制生成 orchestrator.md。

## orchestrator.md 的核心结构

一个完整的 orchestrator.md 必须包含以下部分：

### 1. YAML Front Matter + 角色定义

```markdown
---
name: orchestrator
description: 开发流水线编排器。协调 <阶段列表> 全流程。用户说"开始做""启动流水线""全流程""编排"时触发。支持从中断处恢复。
---

你是 <项目名> 的开发流水线编排器。你的职责是按顺序调度专家 SubAgent 完成一个完整的功能开发周期。
```

### 2. 核心原则（必须保留）

```markdown
## 核心原则

- **你不写代码、不做设计、不做测试**——你只编排和协调
- **每个阶段委托给对应的专家 SubAgent**
- **在关键 Gate 暂停并汇报，等用户说「可以」再继续**
- **中文沟通**，技术术语保留英文
- **主动上报状态**——每个阶段开始/完成时调用 pipeline-server API 上报，不完全依赖 Hook 被动推断
```

如果模板有并行阶段，增加：
```markdown
- **前后端可并行**——implement 和 code-review 阶段拆为前后端独立的 SubAgent 并行执行
```

### 2.5 Pipeline Server API（必须保留）

orchestrator 必须在每个阶段转换时调用 pipeline-server 的 API 主动上报状态。
这是因为 Cursor Hook 只能被动捕获 SubAgent 的 start/stop 事件，
无法感知 Skill 调用、Gate 决策等非 SubAgent 操作。

```markdown
## Pipeline Server API

pipeline-server 运行在 http://127.0.0.1:19090。orchestrator 通过以下 API 主动上报状态：

### 设置 Change 名称
流水线启动时调用一次，设置当前 change 名称。
\`\`\`bash
curl -s -X POST http://127.0.0.1:19090/api/v1/pipeline/change \
  -H "Content-Type: application/json" \
  -d '{"name": "add-skill-favorite"}'
\`\`\`

### 推进阶段状态
每个阶段开始时标记为 active，完成时标记为 completed/failed/skipped。
\`\`\`bash
# 标记阶段开始
curl -s -X POST http://127.0.0.1:19090/api/v1/pipeline/stage \
  -H "Content-Type: application/json" \
  -d '{"stage": "propose", "status": "active"}'

# 标记阶段完成
curl -s -X POST http://127.0.0.1:19090/api/v1/pipeline/stage \
  -H "Content-Type: application/json" \
  -d '{"stage": "propose", "status": "completed"}'
\`\`\`

### 更新 Gate 结果
用户确认后更新 Gate 状态。
\`\`\`bash
curl -s -X POST http://127.0.0.1:19090/api/v1/pipeline/gate \
  -H "Content-Type: application/json" \
  -d '{"gate": "gate1", "result": "passed"}'
\`\`\`

### 重置流水线
\`\`\`bash
curl -s -X POST http://127.0.0.1:19090/api/v1/pipeline/reset
\`\`\`

**重要**：SubAgent 阶段（implement/code-review 等）的 start/stop 由 Hook 自动追踪，
但 orchestrator 仍应在启动并行 Agent 前主动标记阶段为 active，确保看板即时更新。
Skill 阶段（propose/archive）和 Gate 阶段完全依赖主动上报，Hook 无法感知。
```

### 3. 流水线阶段总览

根据模板的 `stages` 生成一个流程图和阶段表格。

流程图格式：
```
propose → review → [Gate 1] → implement(BE ∥ FE) → code-review(BE ∥ FE) → [Gate 2] → qa-test → [Gate 3] → integration-test → archive
```

阶段表格列：阶段名、SubAgent/Skill、是否并行、说明。

### 4. 工作流程（逐阶段详述）

#### 启动时检查

必须包含：
1. 检查 explorer 结论（`.cursor/hooks/state/explorer-conclusion.md`）
2. 检查流水线状态（`.cursor/hooks/state/pipeline-state.json`）
3. 如果都没有——询问用户

#### 每个阶段的详细说明

每个阶段描述中都必须包含 **API 上报调用**，遵循以下模式：

**对于 Skill 阶段**（propose / archive）：
- Hook 无法感知 Skill 调用，必须手动上报
- 阶段开始前：`curl POST /api/v1/pipeline/stage {"stage":"propose","status":"active"}`
- 调用哪个 Skill、传递什么参数
- 阶段完成后：`curl POST /api/v1/pipeline/stage {"stage":"propose","status":"completed"}`
- 如果是 propose，要求 tasks.md 按前后端分组（并行模板时）

**对于单 Agent 阶段**（review / qa-test / test-writer）：
- 阶段开始由 Hook subagentStart 自动标记，但建议仍主动标记确保一致性
- 委托给哪个 SubAgent
- prompt 必须包含的内容（change 名称、要读取的文件、具体指令）
- 阶段完成由 Hook subagentStop 自动标记

**对于并行阶段**（implement / code-review）：
- 启动前主动标记：`curl POST /api/v1/pipeline/stage {"stage":"implement","status":"active"}`
- 用 ASCII 图展示并行结构
- 分别说明每个并行 Agent 的 prompt 内容
- 强调"等待所有并行 SubAgent 都完成后再进入下一阶段"
- Hook 会自动追踪每个 SubAgent 的 start/stop，并在所有同阶段 Agent 完成后标记阶段为 completed

**对于 Gate 阶段**：
- 必须给出用户看到的交互格式模板
- 包含具体选项（通过/修改/放弃）
- 用户确认后：`curl POST /api/v1/pipeline/gate {"gate":"gate1","result":"passed"}`
- 不同 Gate 的选项可以不同

#### Gate 交互格式参考

```markdown
## Gate N：<标题>

<上一阶段的结论/报告摘要>

**选项：**
1. 通过，继续下一步
2. 需要修改
3. 跳过 / 放弃
```

### 5. 中断恢复逻辑

必须包含：
```markdown
## 中断恢复逻辑

当用户说「继续」或再次调用 orchestrator 时：
1. 读取 `.cursor/hooks/state/pipeline-state.json`
2. 根据 `current_stage` 和 `stages` 的状态，定位到中断点
3. 告知用户当前恢复点，确认后继续
```

### 6. 并行调度注意事项（有并行阶段时）

```markdown
## 并行调度注意事项

- 启动并行 SubAgent 时，在同一条消息中发起多个 Task 工具调用
- 等待所有并行 SubAgent 完成后再进入下一阶段
- 如果一个失败了，另一个的结果仍然保留，只重跑失败的那个
```

### 7. 跳过与回退

```markdown
## 跳过与回退

用户可以在任何 Gate 处：
- **跳过当前阶段**：说「跳过」
- **回到某个阶段**：说「回到 implement」
- **终止流水线**：说「停」「暂停」，保存状态并退出
```

### 8. 约束

```markdown
## 约束

- 绝不自己写代码或做设计——所有工作委托给专家 SubAgent
- Gate 处必须暂停——不能自动跳过 Gate，必须等用户确认
- 传递完整上下文——调度 SubAgent 时提供足够的 prompt 上下文
- 汇报进度——每个阶段完成后简要汇报
```

### 9. 完成总结（archive 阶段后）

```markdown
## 流水线完成

**Change**: <name>

### 各阶段耗时
| 阶段 | 耗时 | 状态 |
|------|------|------|
| ... | Xs | ✅ |

### 产出物
- OpenSpec: openspec/changes/archive/<date>-<name>/
- 测试: <路径>

### 变更摘要
<从 proposal.md 提取>

### 关键决策
<Gate 处的决策记录>
```

## 定制要点

AI 在引导用户创建 orchestrator 时需要了解的信息：

1. **项目名称和技术栈**——影响角色描述
2. **目录结构**——影响 scope、测试路径
3. **测试方式**——是否有 QA 浏览器测试、集成测试如何运行
4. **部署方式**——是否需要在 archive 后触发部署
5. **团队习惯**——Gate 是否需要多人确认、是否需要 code owner review
6. **特殊 Skill**——项目是否有自定义 Skill 需要在某个阶段调用

## 与模板的关系

- 模板定义了"有哪些阶段、用哪些 Agent"
- orchestrator.md 定义了"如何编排这些阶段、如何与用户交互"
- 两者需要保持一致：orchestrator 引用的 Agent 名称必须与模板中的 agents key 对应
