#!/bin/bash
# 文件编辑后自动格式化：Go 文件跑 gofmt，前端文件跑 prettier

input=$(cat)
file_path=$(echo "$input" | jq -r '.file_path // empty')

if [ -z "$file_path" ]; then
  exit 0
fi

case "$file_path" in
  *.go)
    if command -v gofmt &> /dev/null; then
      gofmt -w "$file_path" 2>/dev/null
    fi
    if command -v goimports &> /dev/null; then
      goimports -w "$file_path" 2>/dev/null
    fi
    ;;
  *.ts|*.tsx|*.js|*.jsx|*.css|*.scss)
    if command -v npx &> /dev/null; then
      npx prettier --write "$file_path" 2>/dev/null
    fi
    ;;
esac

exit 0
