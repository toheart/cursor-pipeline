#!/bin/bash
# 初始化流水线：选择模板 → 生成 hooks/agents → 启动 pipeline-server
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
TEMPLATES_DIR="$SKILL_DIR/templates"
PROJECT_DIR="$(pwd)"

echo "=== Cursor Pipeline Initializer ==="
echo ""

# 1. 检查 bun 是否安装
if ! command -v bun &> /dev/null; then
  echo "Error: bun is not installed. Install it with: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

# 2. 列出可用模板
echo "Available templates:"
echo ""
idx=1
templates=()
for tpl in "$TEMPLATES_DIR"/*.yaml "$TEMPLATES_DIR"/*.yml; do
  [ -f "$tpl" ] || continue
  name=$(basename "$tpl" | sed 's/\.ya\?ml$//')
  desc=$(head -5 "$tpl" | grep "^description:" | sed 's/^description: *//')
  echo "  [$idx] $name - $desc"
  templates+=("$tpl")
  idx=$((idx + 1))
done
echo ""

if [ ${#templates[@]} -eq 0 ]; then
  echo "Error: No templates found in $TEMPLATES_DIR"
  exit 1
fi

# 3. 用户选择模板
read -p "Select template [1-${#templates[@]}]: " choice
if [ -z "$choice" ] || [ "$choice" -lt 1 ] || [ "$choice" -gt ${#templates[@]} ] 2>/dev/null; then
  echo "Invalid choice. Using template 1."
  choice=1
fi
SELECTED="${templates[$((choice - 1))]}"
SELECTED_NAME=$(basename "$SELECTED" | sed 's/\.ya\?ml$//')
echo ""
echo "Selected: $SELECTED_NAME"
echo ""

# 4. 创建 .cursor/hooks 目录并复制文件
HOOKS_DIR="$PROJECT_DIR/.cursor/hooks"
mkdir -p "$HOOKS_DIR"
mkdir -p "$HOOKS_DIR/state"

cp "$SCRIPT_DIR/forward-hook.sh" "$HOOKS_DIR/forward-hook.sh"
cp "$SCRIPT_DIR/auto-format.sh" "$HOOKS_DIR/auto-format.sh"
cp "$SCRIPT_DIR/pipeline-server.ts" "$HOOKS_DIR/pipeline-server.ts"
echo "Copied hook scripts to $HOOKS_DIR/"

# 5. 生成 hooks.json（如果不存在则创建，否则提示）
HOOKS_JSON="$PROJECT_DIR/.cursor/hooks.json"
if [ -f "$HOOKS_JSON" ]; then
  echo "hooks.json already exists, skipping. Remove it first to regenerate."
else
  cp "$SCRIPT_DIR/hooks.json.tpl" "$HOOKS_JSON"
  echo "Created $HOOKS_JSON"
fi

# 6. 生成 Agent .md 文件
AGENTS_DIR="$PROJECT_DIR/.cursor/agents"
echo ""
echo "Generating agent definitions..."
bun run "$SCRIPT_DIR/generate-agents.ts" "$SELECTED" "$AGENTS_DIR"

echo ""
echo "=== Initialization Complete ==="
echo ""
echo "Generated files:"
echo "  .cursor/hooks/    → Hook scripts + pipeline-server"
echo "  .cursor/hooks.json → Hook configuration"
echo "  .cursor/agents/   → Agent definitions (without orchestrator)"
echo ""
echo "Next steps:"
echo "  1. Create orchestrator.md:"
echo "     In Cursor, activate the cursor-pipeline Skill and follow"
echo "     the guided process to create .cursor/agents/orchestrator.md"
echo ""
echo "  2. Start pipeline server:"
echo "     bun run .cursor/hooks/pipeline-server.ts -t $SELECTED_NAME"
echo ""
echo "  3. Open dashboard: http://127.0.0.1:19090/"
