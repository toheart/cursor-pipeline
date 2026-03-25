# Pipeline Template Format

编排模板使用 YAML 格式定义流水线的阶段顺序和变量。模板**不定义 Agent**，只引用项目中已有的 `.cursor/agents/*.md`。

## 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 模板名称（kebab-case） |
| `description` | string | 是 | 模板描述 |
| `variables` | object | 否 | 可在 `scope` 等字段中用 `{var}` 引用的变量 |
| `stages` | array | 是 | 流水线阶段定义 |

## stages 字段

每个 stage 支持以下字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 阶段名称（用于状态追踪） |
| `label` | string | 是 | 看板显示标签 |
| `agent` | string | 否 | 引用 `.cursor/agents/` 下已有 Agent 的名称 |
| `skill` | string | 否 | 使用 Skill 而非 SubAgent |
| `gate` | boolean | 否 | 是否为 Gate（需要用户确认） |
| `gate_description` | string | 否 | Gate 的描述文本（如"确认方案设计"），不填时使用 label |
| `optional` | boolean | 否 | 是否可选阶段 |
| `parallel` | array | 否 | 并行 Agent 列表，每项含 `agent` 和 `scope` |

**`agent` 字段是引用，不是定义**。其值必须与 `.cursor/agents/` 目录下某个 `.md` 文件的文件名（不含扩展名）对应。

## 变量替换

`scope` 等字段中的 `{变量名}` 会被 `variables` 中的值替换。未匹配的变量原样保留。

## 示例

```yaml
name: go-react-fullstack
description: Go + React 全栈编排模板
variables:
  project_name: my-project
  backend_dir: backend/
  frontend_dir: frontend/
stages:
  - name: propose
    label: Propose
    skill: openspec-propose

  - name: gate1
    label: "Gate 1"
    gate: true
    gate_description: "确认方案设计"

  - name: implement
    label: "BE ∥ FE"
    parallel:
      - agent: backend-implementer
        scope: "## Backend Tasks"
      - agent: frontend-implementer
        scope: "## Frontend Tasks"

  - name: archive
    label: Archive
    skill: openspec-archive
```
