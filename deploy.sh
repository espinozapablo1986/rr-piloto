#!/usr/bin/env bash
# Despliegue en el VPS: trae los cambios del repositorio y reconstruye el stack.
#
#   ssh root@159.195.7.134 '/opt/stacks/rr-piloto/deploy.sh'
set -euo pipefail

STACK_DIR="${STACK_DIR:-/opt/stacks/rr-piloto}"
cd "$STACK_DIR"

echo "==> Trayendo cambios"
git pull --ff-only origin "${BRANCH:-main}"

echo "==> Reconstruyendo contenedor"
docker compose up -d --build --remove-orphans

echo "==> Limpiando imágenes huérfanas"
docker image prune -f >/dev/null

echo "==> Estado"
docker compose ps
