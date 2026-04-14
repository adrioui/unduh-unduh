#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${ROOT_DIR}/.runtime/local-origin"
TUNNEL_URL_FILE="${STATE_DIR}/tunnel-url.txt"
API_KEY_FILE="${STATE_DIR}/api-key.txt"
DOWNLOAD_SECRET_FILE="${STATE_DIR}/download-token-secret.txt"

log() {
  printf '[publish] %s\n' "$*"
}

ensure_download_secret() {
  if [[ ! -s "${DOWNLOAD_SECRET_FILE}" ]]; then
    node -e 'console.log(crypto.randomBytes(32).toString("hex"))' >"${DOWNLOAD_SECRET_FILE}"
  fi
}

put_secret() {
  local name="$1"
  local value="$2"
  printf '%s' "${value}" | npx wrangler secret put "${name}" >/dev/null
  log "updated worker secret ${name}"
}

main() {
  bash "${ROOT_DIR}/scripts/start-local-origin.sh"

  if [[ ! -s "${TUNNEL_URL_FILE}" || ! -s "${API_KEY_FILE}" ]]; then
    printf 'local service state is incomplete; expected tunnel URL and API key files\n' >&2
    exit 1
  fi

  ensure_download_secret

  local tunnel_url
  local api_key
  local download_secret
  tunnel_url="$(tr -d '\n' <"${TUNNEL_URL_FILE}")"
  api_key="$(tr -d '\n' <"${API_KEY_FILE}")"
  download_secret="$(tr -d '\n' <"${DOWNLOAD_SECRET_FILE}")"

  put_secret "COBALT_API_URL" "${tunnel_url}"
  put_secret "COBALT_API_KEY" "${api_key}"
  put_secret "DOWNLOAD_TOKEN_SECRET" "${download_secret}"

  log "deploying worker with local yt-dlp tunnel"
  npx wrangler deploy
}

main "$@"

