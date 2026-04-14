#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="${ROOT_DIR}/.runtime/local-origin/origin.pid"

if [[ -f "${PID_FILE}" ]]; then
  pid="$(cat "${PID_FILE}")"
  if kill -0 "${pid}" >/dev/null 2>&1; then
    kill "${pid}" >/dev/null 2>&1 || true
    wait "${pid}" 2>/dev/null || true
  fi
  rm -f "${PID_FILE}"
fi

for container in clip-harbor-cloudflared clip-harbor-cloudflared-test clip-harbor-cobalt-origin clip-harbor-cobalt-real; do
  docker rm -f "${container}" >/dev/null 2>&1 || true
done

printf '[origin] stopped local origin process + tunnel containers\n'
