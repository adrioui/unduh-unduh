#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/.runtime/local-origin"
PID_FILE="${RUNTIME_DIR}/server.pid"
LEGACY_PID_FILE="${RUNTIME_DIR}/origin.pid"

for current_pid_file in "${PID_FILE}" "${LEGACY_PID_FILE}"; do
  if [[ -f "${current_pid_file}" ]]; then
    pid="$(cat "${current_pid_file}")"
    if kill -0 "${pid}" >/dev/null 2>&1; then
      kill "${pid}" >/dev/null 2>&1 || true
      wait "${pid}" 2>/dev/null || true
    fi
  fi
done

rm -f "${PID_FILE}" "${LEGACY_PID_FILE}"

if command -v docker >/dev/null 2>&1; then
  for container in clip-harbor-cloudflared clip-harbor-cloudflared-test; do
    docker rm -f "${container}" >/dev/null 2>&1 || true
  done
fi

printf '[local] stopped local yt-dlp bridge + tunnel containers\n'
