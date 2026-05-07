#!/usr/bin/env bash

set -Eeuo pipefail

DEPLOY_PATH="${DEPLOY_PATH:?DEPLOY_PATH is required}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:?ENV_FILE is required}"
APP_IMAGE_NAME="${APP_IMAGE_NAME:?APP_IMAGE_NAME is required}"
NGINX_IMAGE_NAME="${NGINX_IMAGE_NAME:?NGINX_IMAGE_NAME is required}"
SERVICE_NAMES="${SERVICE_NAMES:-app nginx}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:3000/health}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-15}"
SLEEP_SECONDS="${SLEEP_SECONDS:-5}"

cd "${DEPLOY_PATH}"

previous_app_image=""
previous_nginx_image=""

for service_name in ${SERVICE_NAMES}; do
  previous_container_id="$(docker compose -f "${COMPOSE_FILE}" ps -q "${service_name}" 2>/dev/null || true)"
  if [[ -z "${previous_container_id}" ]]; then
    continue
  fi

  previous_image="$(docker inspect -f '{{.Config.Image}}' "${previous_container_id}")"
  if [[ "${service_name}" == "app" ]]; then
    previous_app_image="${previous_image}"
  elif [[ "${service_name}" == "nginx" ]]; then
    previous_nginx_image="${previous_image}"
  fi
done

rollback() {
  if [[ -z "${previous_app_image}" || -z "${previous_nginx_image}" ]]; then
    echo "Previous images are incomplete; skipping rollback."
    return
  fi

  echo "Rolling back to app=${previous_app_image} nginx=${previous_nginx_image}"
  export APP_IMAGE_NAME="${previous_app_image}"
  export NGINX_IMAGE_NAME="${previous_nginx_image}"
  export ENV_FILE
  docker compose -f "${COMPOSE_FILE}" up -d
}

trap 'echo "Deployment failed before completion."; rollback' ERR

echo "Deploying app=${APP_IMAGE_NAME} nginx=${NGINX_IMAGE_NAME}"
export APP_IMAGE_NAME
export NGINX_IMAGE_NAME
export ENV_FILE

docker compose -f "${COMPOSE_FILE}" pull
docker compose -f "${COMPOSE_FILE}" up -d

attempt=1
until curl -fsS "${HEALTHCHECK_URL}" >/tmp/feedback-agent-healthcheck.json; do
  if (( attempt >= MAX_ATTEMPTS )); then
    echo "Health check failed after ${MAX_ATTEMPTS} attempts."
    exit 1
  fi

  echo "Waiting for app health check (${attempt}/${MAX_ATTEMPTS})..."
  attempt=$((attempt + 1))
  sleep "${SLEEP_SECONDS}"
done

if ! grep -q '"ok"[[:space:]]*:[[:space:]]*true' /tmp/feedback-agent-healthcheck.json; then
  echo "Health check response did not report ok=true."
  exit 1
fi

trap - ERR

echo "Deployment healthy on ${HEALTHCHECK_URL}"
docker image prune -f
