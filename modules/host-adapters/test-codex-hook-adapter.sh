#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ADAPTER="$ROOT/modules/host-adapters/codex-hook-adapter.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0

check_jq() {
  local label="$1" expression="$2" value="$3"
  if printf '%s' "$value" | jq -e "$expression" >/dev/null 2>&1; then
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label" >&2
    FAIL=$((FAIL + 1))
  fi
}

cat > "$TMP/context.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
printf 'fixture context'
EOF
cat > "$TMP/deny.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"fixture"}}'
EOF
cat > "$TMP/warn.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
printf 'fixture warning' >&2
EOF
cat > "$TMP/silent.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
EOF

PROMPT="$(printf '{}' | bash "$ADAPTER" UserPromptSubmit "$TMP/context.sh")"
check_jq "prompt context" \
  '.hookSpecificOutput.hookEventName == "UserPromptSubmit" and .hookSpecificOutput.additionalContext == "fixture context"' \
  "$PROMPT"

DENY="$(printf '{}' | bash "$ADAPTER" PreToolUse "$TMP/deny.sh")"
check_jq "deny passthrough" \
  '.hookSpecificOutput.permissionDecision == "deny"' "$DENY"

POST="$(printf '{}' | bash "$ADAPTER" PostToolUse "$TMP/context.sh")"
check_jq "post wrapping" \
  '.hookSpecificOutput.hookEventName == "PostToolUse" and .hookSpecificOutput.additionalContext == "fixture context"' \
  "$POST"

STOP="$(printf '{}' | bash "$ADAPTER" Stop "$TMP/warn.sh" 2>/dev/null)"
check_jq "stop remains advisory" \
  '.continue == true and .systemMessage == "fixture warning"' "$STOP"

SILENT="$(printf '{}' | bash "$ADAPTER" PreToolUse "$TMP/silent.sh")"
if [ -z "$SILENT" ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi

printf 'host-adapter: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
