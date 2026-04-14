#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/.runtime/local-origin"
STATE_FILE="${RUNTIME_DIR}/state.json"
LEGACY_STATE_FILE="${RUNTIME_DIR}/origin.json"
PID_FILE="${RUNTIME_DIR}/server.pid"
LEGACY_PID_FILE="${RUNTIME_DIR}/origin.pid"

printf '[local] containers\n'
if command -v docker >/dev/null 2>&1; then
  docker ps --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}' | grep 'clip-harbor-' || true
else
  printf 'docker is not installed\n'
fi

printf '\n[local] process\n'
ACTIVE_PID_FILE=""
if [[ -f "${PID_FILE}" ]]; then
  ACTIVE_PID_FILE="${PID_FILE}"
elif [[ -f "${LEGACY_PID_FILE}" ]]; then
  ACTIVE_PID_FILE="${LEGACY_PID_FILE}"
fi

if [[ -n "${ACTIVE_PID_FILE}" ]]; then
  pid="$(cat "${ACTIVE_PID_FILE}")"
  if kill -0 "${pid}" >/dev/null 2>&1; then
    printf 'local yt-dlp bridge pid %s is running\n' "${pid}"
  else
    printf 'local yt-dlp bridge pid %s is not running\n' "${pid}"
  fi
else
  printf 'no pid file yet\n'
fi

ACTIVE_STATE_FILE=""
if [[ -f "${STATE_FILE}" ]]; then
  ACTIVE_STATE_FILE="${STATE_FILE}"
elif [[ -f "${LEGACY_STATE_FILE}" ]]; then
  ACTIVE_STATE_FILE="${LEGACY_STATE_FILE}"
fi

if [[ -n "${ACTIVE_STATE_FILE}" ]]; then
  printf '\n[local] state\n'
  cat "${ACTIVE_STATE_FILE}"
else
  printf '\n[local] no saved state yet\n'
fi
