# Pipeline Template Format

模板使用 YAML 格式定义流水线的阶段、Agent 角色和变量。

## 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 模板名称（kebab-case） |
| `description` | string | 是 | 模板描述 |
| `variables` | object | 否 | 可在 agent system prompt 中用 `{var}` 引用的变量 |
| `stages` | array | 是 | 流水线阶段定义 |
| `agents` | object | 是 | Agent 角色定义（key 为 agent 名称） |

## stages 字段

每个 stage 支持以下字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 阶段名称（用于状态追踪） |
| `label` | string | 看板显示标签 |
| `agent` | string | 单 Agent 阶段，引用 agents 中的 key |
| `skill` | string | 使用 Skill 而非 SubAgent |
| `gate` | boolean | 是否为 Gate（需要用户确认） |
| `optional` | boolean | 是否可选阶段 |
| `parallel` | array | 并行 Agent 列表，每项含 `agent` 和 `scope` |

## agents 字段

每个 agent 支持以下字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `model` | string | 使用的模型 |
| `description` | string | 触发描述 |
| `system` | string | System prompt（支持 `{变量}` 替换） |
| `skills` | array | 引用的 Skill 名称列表 |
| `scope` | string | 工作范围（如 `backend/`） |
| `auto_fix` | boolean | 是否自动修复规范问题（reviewer 用） |

## 变量替换

`system` 字段中的 `{变量名}` 会被 `variables` 中的值替换。
内置变量：`{goal}`（用户目标）、`{change_name}`（变更名称）。
未匹配的变量原样保留。

## 示例

```yaml
name: go-react-fullstack
description: Go + React 全栈开发流水线
variables:
  stack_backend: Go + Gin + DDD
  stack_frontend: React + TypeScript
stages:
  - name: implement
    label: "BE ∥ FE"
    parallel:
      - agent: backend-implementer
        scope: "## Backend Tasks"
      - agent: frontend-implementer
        scope: "## Frontend Tasks"
agents:
  backend-implementer:
    model: claude-4.6-sonnet-medium
    system: "你是一位 {stack_backend} 后端工程师..."
    scope: "backend/"
```
