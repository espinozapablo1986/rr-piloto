#!/usr/bin/env bash
# Despliegue en el VPS: trae los cambios del repositorio y reconstruye el stack.
#
#   ssh root@159.195.7.134 '/opt/stacks/rr-piloto/deploy.sh'
#
# El archivo .env vive solo en el servidor y no está versionado, así que
# `git pull` nunca lo toca.
set -euo pipefail

STACK_DIR="${STACK_DIR:-/opt/stacks/rr-piloto}"
cd "$STACK_DIR"

if [ ! -f .env ]; then
  echo "ERROR: falta $STACK_DIR/.env — cópialo de .env.example y rellénalo." >&2
  exit 1
fi

echo "==> Trayendo cambios"
git pull --ff-only origin "${BRANCH:-main}"

echo "==> Reconstruyendo contenedores"
# --pull baja siempre la última imagen base (node:22-alpine, nginx, postgres):
# así cada despliegue incluye los parches de seguridad publicados.
docker compose build --pull
docker compose pull db backup
docker compose up -d --remove-orphans

echo "==> Limpiando imágenes huérfanas"
docker image prune -f >/dev/null

echo "==> Estado"
docker compose ps
