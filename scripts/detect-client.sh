#!/bin/bash
# detect-client.sh | detect which coding client this session runs in, and pick dispatch mode.
# Pure ASCII on purpose (writing non-ASCII into shell scripts has corrupted bytes before).
# Usage: bash scripts/detect-client.sh            # human readable
#        bash scripts/detect-client.sh --json     # machine readable
# Output (default): client=<name|unknown> subagent=<yes|no|unknown> mode=<window_subagent|channel_cli> note=<...>
#
# Signal order (most reliable first):
#   1) macOS bundle id / TERM_PROGRAM   2) env var prefixes   3) parent process chain
#   4) client trace dirs in repo         (trace dirs are HINTS only, never authoritative)
#
# Calibration status (all verified by running this script inside the client):
#   subagent=yes -> Orca, Trae, Qoder, Codex, ClaudeCode, opencode, CodeArtsAgent
# CodeArts Agent notes (verified 2026-10-03):
#   - It is an Electron app: its main process comm is just "Electron", so the ppid walk
#     cannot identify it. Only bundle id / TERM_PROGRAM / env can.
#   - Its agent backend IS Codex. When the script runs inside CodeArts Agent, the bundle id
#     inherited is the Codex one, so it reports client=Codex subagent=yes. That is correct and
#     desired: dispatch capability is identical (codex subagents available either way).
#
# Rules encoded here:
#   - subagent=yes  -> client can spawn its own subagents: dispatch via the current window (keeps true resume/parallel/isolation)
#   - subagent=no   -> dispatch via channel CLI (codex exec / codebuddy / opencode run)
#   - subagent=unknown (uncalibrated client) -> conservative default: channel_cli, note it once, do NOT ask the user
set -u

CLIENT=unknown
SUBAGENT=unknown
SOURCE=""
NOTE=""

norm() { echo "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '_-' | tr -d ' '; }

# 1) bundle id
bundle="${__CFBundleIdentifier:-}"
case "$bundle" in
  *orca*)   CLIENT=Orca;     SUBAGENT=yes; SOURCE=bundleid ;;
  *trae*)   CLIENT=Trae;     SUBAGENT=yes; SOURCE=bundleid ;;
  *qoder*)  CLIENT=Qoder;    SUBAGENT=yes; SOURCE=bundleid ;;
  *claude*) CLIENT=ClaudeCode; SUBAGENT=yes; SOURCE=bundleid ;;
  *codearts*) CLIENT=CodeArtsAgent; SUBAGENT=yes; SOURCE=bundleid ;;  # Electron app: main process is just "Electron" (ppid walk cannot see it).
  *code*)   CLIENT=Codex;    SUBAGENT=yes; SOURCE=bundleid ;;
esac

# 2) TERM_PROGRAM
if [ "$CLIENT" = unknown ]; then
  tp="$(echo "${TERM_PROGRAM:-}" | norm)"
  case "$tp" in
    orca)          CLIENT=Orca;       SUBAGENT=yes; SOURCE=termprogram ;;
    trae*|traecode) CLIENT=Trae;      SUBAGENT=yes; SOURCE=termprogram ;;
    qoder*)        CLIENT=Qoder;      SUBAGENT=yes; SOURCE=termprogram ;;
    *codex*)       CLIENT=Codex;      SUBAGENT=yes; SOURCE=termprogram ;;
    claude*|appt*) CLIENT=ClaudeCode; SUBAGENT=yes; SOURCE=termprogram ;;
    opencode*)     CLIENT=opencode;   SUBAGENT=yes; SOURCE=termprogram ;;
    *codearts*)    CLIENT=CodeArtsAgent; SUBAGENT=yes; SOURCE=termprogram ;;
  esac
fi

# 3) env var prefixes
if [ "$CLIENT" = unknown ]; then
  if [ -n "${ORCA_APP_VERSION:-}${ORCA_WORKSPACE_ID:-}" ]; then
    CLIENT=Orca; SUBAGENT=yes; SOURCE=env
  elif [ -n "${OPENCODE:-}" ] || [ -n "${OPENCODE_PID:-}" ]; then
    CLIENT=opencode; SUBAGENT=yes; SOURCE=env
  elif [ -n "${CLAUDECODE:-}" ] || [ -n "${CLAUDE_CODE_ENTRYPOINT:-}" ]; then
    CLIENT=ClaudeCode; SUBAGENT=yes; SOURCE=env
  elif [ -n "${CODEX_SANDBOX:-}" ] || [ -n "${CODEX_THREAD_ID:-}" ] || [ -n "${CODEX_HOME:-}" ]; then
    CLIENT=Codex; SUBAGENT=yes; SOURCE=env
  elif [ -n "${TRAE_:-}" ] || [ -n "${TRAE_HOME:-}" ] || [ -n "${TRAE_IDE:-}" ]; then
    CLIENT=Trae; SUBAGENT=yes; SOURCE=env
  elif [ -n "${QODER_:-}" ] || [ -n "${QODER_HOME:-}" ] || [ -n "${QODER_IDE:-}" ]; then
    CLIENT=Qoder; SUBAGENT=yes; SOURCE=env
  elif [ -n "${CODEARTS_:-}" ] || [ -n "${CODEARTS_HOME:-}" ] || [ -n "${CODEARTS_AGENT:-}" ]; then
    CLIENT=CodeArtsAgent; SUBAGENT=yes; SOURCE=env
  fi
fi

# 4) parent process chain (walk up, max 8 levels)
if [ "$CLIENT" = unknown ]; then
  p=$$
  i=0
  while [ $i -lt 8 ]; do
    i=$((i+1))
    pp="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
    [ -z "$pp" ] && break
    comm="$(ps -o comm= -p "$pp" 2>/dev/null | tr -d ' ')"
    cn="$(norm "${comm:-}")"
    case "$cn" in
      *orca*)            CLIENT=Orca;       SUBAGENT=yes; SOURCE=ppid ;;
      *trae*)            CLIENT=Trae;       SUBAGENT=yes; SOURCE=ppid ;;
      *qoder*)           CLIENT=Qoder;      SUBAGENT=yes; SOURCE=ppid ;;
      *codex*)           CLIENT=Codex;      SUBAGENT=yes; SOURCE=ppid ;;
      *claude*)          CLIENT=ClaudeCode; SUBAGENT=yes; SOURCE=ppid ;;
      *opencode*)        CLIENT=opencode;   SUBAGENT=yes; SOURCE=ppid ;;
      *codearts*)        CLIENT=CodeArtsAgent; SUBAGENT=yes; SOURCE=ppid ;;
    esac
    [ "$CLIENT" != unknown ] && break
    [ "$pp" -le 1 ] 2>/dev/null && break
    p="$pp"
  done
fi

# 5) repo trace dirs (hint only)
hint=""
for d in .claude .codex .trae .qoder .orca; do
  [ -d "$d" ] && hint="$hint $d"
done

if [ "$CLIENT" = unknown ]; then
  MODE=channel_cli
  NOTE="client-not-recognized; using channel_cli; add this client to scripts/detect-client.sh after one calibration run"
else
  case "$SUBAGENT" in
    yes) MODE=window_subagent ;;
    *)   MODE=channel_cli; NOTE="subagent-support-unconfirmed-for-$CLIENT; using channel_cli" ;;
  esac
fi

if [ "${1:-}" = "--json" ]; then
  printf '{"client":"%s","subagent":"%s","mode":"%s","source":"%s","trace_hints":"%s","note":"%s"}\n' \
    "$CLIENT" "$SUBAGENT" "$MODE" "${SOURCE:-none}" "${hint# }" "$NOTE"
else
  echo "client=$CLIENT subagent=$SUBAGENT mode=$MODE source=${SOURCE:-none}"
  [ -n "$hint" ] && echo "trace_hints=$hint  (hint only, not authoritative)"
  [ -n "$NOTE" ] && echo "note=$NOTE"
fi

exit 0
