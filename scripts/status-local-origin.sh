#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="${ROOT_DIR}/.runtime/local-origin/origin.json"
PID_FILE="${ROOT_DIR}/.runtime/local-origin/origin.pid"

printf '[origin] containers\n'
docker ps --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}' | grep 'clip-harbor-' || true

printf '\n[origin] process\n'
if [[ -f "${PID_FILE}" ]]; then
  pid="$(cat "${PID_FILE}")"
  if kill -0 "${pid}" >/dev/null 2>&1; then
    printf 'local origin pid %s is running\n' "${pid}"
  else
    printf 'local origin pid %s is not running\n' "${pid}"
  fi
else
  printf 'no pid file yet\n'
fi

if [[ -f "${STATE_FILE}" ]]; then
  printf '\n[origin] state\n'
  cat "${STATE_FILE}"
else
  printf '\n[origin] no saved state yet\n'
fi
