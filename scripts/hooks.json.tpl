{
  "version": 1,
  "hooks": {
    "sessionStart": [
      {
        "command": "bash .cursor/hooks/forward-hook.sh"
      }
    ],
    "afterFileEdit": [
      {
        "command": "bash .cursor/hooks/auto-format.sh",
        "matcher": "Write"
      }
    ],
    "beforeShellExecution": [
      {
        "command": "bash .cursor/hooks/forward-hook.sh",
        "matcher": "git push|git reset --hard|kubectl apply|docker push"
      }
    ],
    "subagentStart": [
      {
        "command": "bash .cursor/hooks/forward-hook.sh"
      }
    ],
    "subagentStop": [
      {
        "command": "bash .cursor/hooks/forward-hook.sh"
      }
    ],
    "stop": [
      {
        "command": "bash .cursor/hooks/forward-hook.sh",
        "loop_limit": 3
      }
    ]
  }
}
