#!/usr/bin/env bash
# Translate host-neutral hook stdout/stderr into the Codex lifecycle-hook contract.
set -euo pipefail

EVENT="${1:?event required}"
shift
INNER="${1:?inner hook script required}"
shift

STDIN="$(cat)"
ERRFILE="$(mktemp 2>/dev/null || true)"
if [ -z "$ERRFILE" ]; then
  echo "codex-hook-adapter[$EVENT] WARN: stderr capture unavailable; hook skipped." >&2
  exit 0
fi
OUT="$(printf '%s' "$STDIN" | bash "$INNER" "$@" 2>"$ERRFILE")" || true
ERR="$(cat "$ERRFILE" 2>/dev/null || true)"
rm -f "$ERRFILE" 2>/dev/null || true
[ -n "$ERR" ] && printf 'codex-hook-adapter[%s] inner stderr:\n%s\n' "$EVENT" "$ERR" >&2

json_string() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$1" | jq -Rs .
  elif command -v python3 >/dev/null 2>&1; then
    printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
  else
    printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' -e ':a' -e 'N' -e '$!ba' -e 's/\n/\\n/g')"
  fi
}

case "$EVENT" in
  UserPromptSubmit)
    [ -n "$OUT" ] || exit 0
    printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":%s}}\n' \
      "$EVENT" "$(json_string "$OUT")"
    ;;
  PostToolUse)
    [ -n "$OUT" ] || exit 0
    if command -v jq >/dev/null 2>&1 \
      && printf '%s' "$OUT" | jq -e \
        '.hookSpecificOutput.hookEventName == "PostToolUse" and (.hookSpecificOutput.additionalContext | type == "string")' \
        >/dev/null 2>&1; then
      printf '%s\n' "$OUT"
    else
      printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":%s}}\n' \
        "$EVENT" "$(json_string "$OUT")"
    fi
    ;;
  PreToolUse)
    [ -n "$OUT" ] && printf '%s\n' "$OUT"
    ;;
  Stop)
    [ -n "$ERR" ] && printf '{"systemMessage":%s,"continue":true}\n' "$(json_string "$ERR")"
    ;;
  *)
    [ -n "$OUT" ] && printf '%s\n' "$OUT"
    ;;
esac
