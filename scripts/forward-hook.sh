#!/bin/bash
# 将 Hook stdin JSON 转发给 pipeline-server，fail-open
PIPELINE_SERVER="http://127.0.0.1:19090"
input=$(cat)

# sessionStart 时自动注册当前项目的模板目录
event_name=$(echo "$input" | grep -o '"hook_event_name":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ "$event_name" = "sessionStart" ]; then
  pipelines_dir="$(pwd)/.cursor/pipelines"
  if [ -d "$pipelines_dir" ]; then
    project_name=$(basename "$(pwd)")
    curl -s --max-time 2 -X POST "$PIPELINE_SERVER/api/v1/templates/register" \
      -H "Content-Type: application/json" \
      -d "{\"project\":\"$project_name\",\"dir\":\"$pipelines_dir\"}" >/dev/null 2>&1 || true
  fi
fi

response=$(echo "$input" | curl -s --max-time 3 -X POST -H "Content-Type: application/json" -d @- "$PIPELINE_SERVER/api/v1/pipeline/hook" 2>/dev/null)
[ $? -ne 0 ] || [ -z "$response" ] && echo '{}' && exit 0
echo "$response"
