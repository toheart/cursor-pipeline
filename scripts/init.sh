#!/bin/bash
# 初始化流水线：选择模板 → 生成 orchestrator → 部署 hooks → 注册 pipeline
# 支持同一项目创建多个流水线实例
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
TEMPLATES_DIR="$SKILL_DIR/templates"
PROJECT_DIR="$(pwd)"
SELECTED=""
PIPELINE_ID=""

# 解析命令行参数
while getopts "t:p:" opt; do
  case $opt in
    t) TEMPLATE_ARG="$OPTARG" ;;
    p) PIPELINE_ID="$OPTARG" ;;
    *) echo "Usage: $0 [-t template-name-or-path] [-p pipeline-id]"; exit 1 ;;
  esac
done

echo "=== Cursor Pipeline Initializer ==="
echo ""

# 1. 检查依赖
if ! command -v bun &> /dev/null; then
  echo "Error: bun is not installed. Install it with: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

if ! command -v jq &> /dev/null; then
  echo "Warning: jq is not installed. Hook scripts (auto-format.sh) require jq to parse JSON."
  echo "Install it with: apt-get install jq / brew install jq / choco install jq"
fi

# 2. 选择模板
if [ -n "$TEMPLATE_ARG" ]; then
  # 先检查是否是直接路径
  if [ -f "$TEMPLATE_ARG" ]; then
    SELECTED="$TEMPLATE_ARG"
  else
    for ext in yaml yml; do
      candidate="$TEMPLATES_DIR/$TEMPLATE_ARG.$ext"
      if [ -f "$candidate" ]; then
        SELECTED="$candidate"
        break
      fi
    done
  fi
  if [ -z "$SELECTED" ]; then
    echo "Error: Template '$TEMPLATE_ARG' not found."
    echo "Available built-in templates:"
    for tpl in "$TEMPLATES_DIR"/*.yaml "$TEMPLATES_DIR"/*.yml; do
      [ -f "$tpl" ] || continue
      echo "  - $(basename "$tpl" | sed 's/\.ya\?ml$//')"
    done
    exit 1
  fi
else
  templates=()
  for tpl in "$TEMPLATES_DIR"/*.yaml "$TEMPLATES_DIR"/*.yml; do
    [ -f "$tpl" ] || continue
    templates+=("$tpl")
  done
  if [ ${#templates[@]} -eq 0 ]; then
    echo "Error: No templates found in $TEMPLATES_DIR"
    exit 1
  fi
  echo "Available templates:"
  echo ""
  idx=1
  for tpl in "${templates[@]}"; do
    name=$(basename "$tpl" | sed 's/\.ya\?ml$//')
    desc=$(head -5 "$tpl" | grep "^description:" | sed 's/^description: *//')
    echo "  [$idx] $name - $desc"
    idx=$((idx + 1))
  done
  echo ""
  read -p "Select template [1-${#templates[@]}]: " choice
  if [ -z "$choice" ] || [ "$choice" -lt 1 ] || [ "$choice" -gt ${#templates[@]} ] 2>/dev/null; then
    echo "Invalid choice. Using template 1."
    choice=1
  fi
  SELECTED="${templates[$((choice - 1))]}"
fi

SELECTED_NAME=$(basename "$SELECTED" | sed 's/\.ya\?ml$//')

# 3. 确定 pipeline ID
if [ -z "$PIPELINE_ID" ]; then
  PIPELINE_ID="$SELECTED_NAME"
fi

echo "Template:    $SELECTED_NAME"
echo "Pipeline ID: $PIPELINE_ID"
echo ""

# 4. 部署 hook 脚本
HOOKS_DIR="$PROJECT_DIR/.cursor/hooks"
mkdir -p "$HOOKS_DIR"
mkdir -p "$HOOKS_DIR/state"

cp "$SCRIPT_DIR/forward-hook.sh" "$HOOKS_DIR/forward-hook.sh"
cp "$SCRIPT_DIR/auto-format.sh" "$HOOKS_DIR/auto-format.sh"
cp "$SCRIPT_DIR/pipeline-server.ts" "$HOOKS_DIR/pipeline-server.ts"
cp "$SCRIPT_DIR/yaml-parser.ts" "$HOOKS_DIR/yaml-parser.ts"
echo "Copied hook scripts to $HOOKS_DIR/"

# 5. 复制看板 HTML
ASSETS_DIR="$PROJECT_DIR/.cursor/hooks/assets"
mkdir -p "$ASSETS_DIR"
if [ -f "$SKILL_DIR/assets/dashboard.html" ]; then
  cp "$SKILL_DIR/assets/dashboard.html" "$ASSETS_DIR/dashboard.html"
  echo "Copied dashboard.html to $ASSETS_DIR/"
fi

# 6. 生成 hooks.json（如果不存在）
HOOKS_JSON="$PROJECT_DIR/.cursor/hooks.json"
if [ -f "$HOOKS_JSON" ]; then
  echo "hooks.json already exists, skipping."
else
  cp "$SCRIPT_DIR/hooks.json.tpl" "$HOOKS_JSON"
  echo "Created $HOOKS_JSON"
fi

# 7. 复制模板到项目 pipelines 目录
PIPELINES_DIR="$PROJECT_DIR/.cursor/pipelines"
mkdir -p "$PIPELINES_DIR"
cp "$SELECTED" "$PIPELINES_DIR/$(basename "$SELECTED")"
echo "Copied template to $PIPELINES_DIR/"

# 8. 生成 orchestrator-{pipeline-id}.md
AGENTS_DIR="$PROJECT_DIR/.cursor/agents"
echo ""
echo "Generating orchestrator-${PIPELINE_ID}.md..."
bun run "$SCRIPT_DIR/generate-orchestrator.ts" "$SELECTED" "$AGENTS_DIR" "$PIPELINE_ID"

# 9. 创建 pipeline state 文件（注册到 pipeline-server）
STATE_FILE="$PROJECT_DIR/.cursor/hooks/state/pipeline-${PIPELINE_ID}.json"
if [ ! -f "$STATE_FILE" ]; then
  # 用 generate-orchestrator.ts 的模板名生成初始 state
  echo "{\"pipeline_id\":\"$PIPELINE_ID\",\"_template_name\":\"$SELECTED_NAME\",\"change_name\":\"\",\"current_stage\":\"\",\"stages\":[],\"active_agents\":[],\"completed_agents\":[],\"gates\":[]}" > "$STATE_FILE"
  echo "Created pipeline state: $STATE_FILE"
fi

echo ""
echo "=== Initialization Complete ==="
echo ""
echo "Pipeline: $PIPELINE_ID (template: $SELECTED_NAME)"
echo ""
echo "Generated files:"
echo "  .cursor/hooks/                              → Hook scripts + pipeline-server"
echo "  .cursor/hooks.json                          → Hook configuration"
echo "  .cursor/pipelines/$SELECTED_NAME.yaml       → Pipeline template"
echo "  .cursor/agents/orchestrator-${PIPELINE_ID}.md → Pipeline orchestrator"
echo ""
echo "Start pipeline server:"
echo "  bun run .cursor/hooks/pipeline-server.ts"
echo ""
echo "Open dashboard: http://127.0.0.1:19090/"
echo ""
echo "To create another pipeline with a different template:"
echo "  bash $0 -t <template> -p <pipeline-id>"
