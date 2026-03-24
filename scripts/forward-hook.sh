#!/bin/bash
# 将 Hook stdin JSON 转发给 pipeline-server，fail-open
input=$(cat)
response=$(echo "$input" | curl -s --max-time 3 -X POST -H "Content-Type: application/json" -d @- "http://127.0.0.1:19090/api/v1/pipeline/hook" 2>/dev/null)
[ $? -ne 0 ] || [ -z "$response" ] && echo '{}' && exit 0
echo "$response"
