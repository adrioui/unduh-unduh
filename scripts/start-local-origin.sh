#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${ROOT_DIR}/.runtime/local-origin"
LOCAL_PORT="${COBALT_LOCAL_PORT:-9010}"
API_KEY_FILE="${STATE_DIR}/api-key.txt"
TUNNEL_URL_FILE="${STATE_DIR}/tunnel-url.txt"
STATE_FILE="${STATE_DIR}/origin.json"
PID_FILE="${STATE_DIR}/origin.pid"
LOG_FILE="${STATE_DIR}/origin.log"
TUNNEL_CONTAINER="${TUNNEL_CONTAINER:-clip-harbor-cloudflared}"

mkdir -p "${STATE_DIR}"

log() {
  printf '[origin] %s\n' "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

ensure_api_key() {
  if [[ ! -s "${API_KEY_FILE}" ]]; then
    node -e 'console.log(crypto.randomUUID())' >"${API_KEY_FILE}"
  fi

  API_KEY="$(tr -d '\n' <"${API_KEY_FILE}")"
  API_KEY="${API_KEY//[$'\r\t ']}"
  if [[ -z "${API_KEY}" ]]; then
    printf 'generated API key is empty\n' >&2
    exit 1
  fi
  export API_KEY
}

stop_origin_process() {
  if [[ -f "${PID_FILE}" ]]; then
    local pid
    pid="$(cat "${PID_FILE}")"
    if kill -0 "${pid}" >/dev/null 2>&1; then
      kill "${pid}" >/dev/null 2>&1 || true
      wait "${pid}" 2>/dev/null || true
    fi
    rm -f "${PID_FILE}"
  fi
}

start_origin_process() {
  local public_api_url="$1"

  stop_origin_process
  : >"${LOG_FILE}"

  log "starting local yt-dlp origin on 127.0.0.1:${LOCAL_PORT}"
  setsid env \
    LOCAL_ORIGIN_API_KEY="${API_KEY}" \
    LOCAL_ORIGIN_PORT="${LOCAL_PORT}" \
    LOCAL_ORIGIN_PUBLIC_URL="${public_api_url}" \
    node --experimental-strip-types "${ROOT_DIR}/scripts/local-origin-server.ts" \
    >"${LOG_FILE}" 2>&1 < /dev/null &

  local pid=$!
  printf '%s\n' "${pid}" >"${PID_FILE}"

  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:${LOCAL_PORT}/" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done

  cat "${LOG_FILE}" >&2 || true
  printf 'local origin did not become ready on port %s\n' "${LOCAL_PORT}" >&2
  exit 1
}

start_tunnel() {
  docker rm -f "${TUNNEL_CONTAINER}" >/dev/null 2>&1 || true

  log "starting quick tunnel to http://127.0.0.1:${LOCAL_PORT}"
  docker run -d --rm \
    --name "${TUNNEL_CONTAINER}" \
    --network host \
    cloudflare/cloudflared:latest \
    tunnel \
    --ha-connections 1 \
    --no-autoupdate \
    --url "http://127.0.0.1:${LOCAL_PORT}" >/dev/null

  local tunnel_url=""
  for _ in $(seq 1 60); do
    tunnel_url="$(
      docker logs "${TUNNEL_CONTAINER}" 2>&1 \
        | grep -Eo 'https://[-a-z0-9]+\.trycloudflare\.com' \
        | tail -n 1 || true
    )"

    if [[ -n "${tunnel_url}" ]]; then
      break
    fi

    if ! docker ps --format '{{.Names}}' | grep -qx "${TUNNEL_CONTAINER}"; then
      docker logs "${TUNNEL_CONTAINER}" >&2 || true
      printf 'quick tunnel container exited unexpectedly\n' >&2
      exit 1
    fi

    sleep 1
  done

  if [[ -z "${tunnel_url}" ]]; then
    docker logs "${TUNNEL_CONTAINER}" >&2 || true
    printf 'could not detect quick tunnel URL\n' >&2
    exit 1
  fi

  printf '%s\n' "${tunnel_url}/" >"${TUNNEL_URL_FILE}"
  export TUNNEL_URL="${tunnel_url}/"
}

write_state_file() {
  node --input-type=module - "${STATE_FILE}" "${API_KEY_FILE}" "${TUNNEL_URL_FILE}" "${LOCAL_PORT}" "${PID_FILE}" "${LOG_FILE}" "${TUNNEL_CONTAINER}" <<'NODE'
import fs from "node:fs";

const [stateFile, apiKeyFile, tunnelFile, localPort, pidFile, logFile, tunnelContainer] =
  process.argv.slice(2);

const apiKey = fs.readFileSync(apiKeyFile, "utf8").trim();
const tunnelUrl = fs.readFileSync(tunnelFile, "utf8").trim();
const pid = fs.readFileSync(pidFile, "utf8").trim();

const state = {
  apiKey,
  logFile,
  originPid: Number(pid),
  localPort: Number(localPort),
  tunnelContainer,
  tunnelUrl,
  updatedAt: new Date().toISOString(),
};

fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
NODE
}

main() {
  require_command curl
  require_command docker
  require_command node
  require_command yt-dlp

  docker rm -f clip-harbor-cobalt-origin clip-harbor-cobalt-real >/dev/null 2>&1 || true
  ensure_api_key
  start_origin_process "http://127.0.0.1:${LOCAL_PORT}/"
  start_tunnel
  start_origin_process "${TUNNEL_URL}"
  write_state_file

  log "local yt-dlp origin is ready"
  log "quick tunnel: ${TUNNEL_URL}"
  log "api key saved to ${API_KEY_FILE}"
  log "state file: ${STATE_FILE}"
}

main "$@"
