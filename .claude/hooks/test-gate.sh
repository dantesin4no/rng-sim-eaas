#!/usr/bin/env bash
# PostToolUse[Edit|Write]: if a trust-boundary file changed, tests must pass.
# Exit 2 feeds the failure back to Claude — closing the loop deterministically.
input=$(cat)
path=$(printf '%s' "$input" | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  try{ const j=JSON.parse(d);
       console.log(j.tool_input?.file_path||j.tool_input?.path||""); }
  catch{ console.log(""); }
});')

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

case "$path" in
  *packages/entropy-core/*)
    if ! (cd "$root" && npm test -w @entropy/core > /tmp/test-gate.log 2>&1); then
      echo "entropy-core tests FAILED after this edit. Output:" >&2
      tail -30 /tmp/test-gate.log >&2
      exit 2
    fi ;;
  *services/entropy-api/*)
    if ! (cd "$root" && npm test -w @entropy/api > /tmp/test-gate.log 2>&1); then
      echo "entropy-api tests FAILED after this edit. Output:" >&2
      tail -30 /tmp/test-gate.log >&2
      exit 2
    fi ;;
esac
exit 0
