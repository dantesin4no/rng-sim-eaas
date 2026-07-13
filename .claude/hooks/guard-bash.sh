#!/usr/bin/env bash
# PreToolUse[Bash]: deterministic guard. Exit 2 blocks the command.
input=$(cat)
cmd=$(printf '%s' "$input" | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  try{ const j=JSON.parse(d); console.log(j.tool_input?.command||""); }
  catch{ console.log(""); }
});')

deny() { echo "BLOCKED by guard-bash.sh: $1" >&2; exit 2; }

case "$cmd" in
  *"rm -rf /"*|*"rm -rf ~"*|*"rm -rf .."*) deny "destructive rm" ;;
  *"git push"*"--force"*|*"git push -f"*)  deny "force push" ;;
  *"chmod -R 777"*)                        deny "world-writable chmod" ;;
esac
exit 0
