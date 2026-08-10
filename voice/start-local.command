#!/bin/sh
set -eu

cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' \
    "Docker не найден." \
    "Установите и запустите Docker Desktop, затем повторите запуск."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  printf '%s\n' \
    "Команда Docker Compose недоступна." \
    "Обновите Docker Desktop и повторите запуск."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  if [ "$(uname -s)" = "Darwin" ] && [ -d /Applications/Docker.app ]; then
    printf '%s\n' "Запускаем Docker Desktop…"
    open -a Docker
    docker_attempt=0
    while [ "$docker_attempt" -lt 60 ]; do
      if docker info >/dev/null 2>&1; then
        break
      fi
      docker_attempt=$((docker_attempt + 1))
      sleep 2
    done
  fi
fi

if ! docker info >/dev/null 2>&1; then
  printf '%s\n' \
    "Docker Desktop не запущен." \
    "Запустите его, дождитесь готовности и повторите запуск."
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  printf '%s\n' "Создан локальный файл настроек .env"
fi

web_port="$(sed -n 's/^WEB_PORT=//p' .env | tail -n 1)"
api_port="$(sed -n 's/^API_PORT=//p' .env | tail -n 1)"
web_port="${web_port:-3000}"
api_port="${api_port:-8000}"

project_directory="$(pwd)"
local_build_directory="$(mktemp -d /tmp/carousel-local.XXXXXX)"
case "$local_build_directory" in
  /tmp/carousel-local.*) ;;
  *)
    printf '%s\n' "Не удалось создать безопасную папку для локальной сборки."
    exit 1
    ;;
esac

cleanup_build_directory() {
  rm -rf -- "$local_build_directory"
}
trap cleanup_build_directory EXIT HUP INT TERM

tar \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./.venv' \
  --exclude='./dist' \
  --exclude='./.next' \
  --exclude='./.vinext' \
  --exclude='./.wrangler' \
  --exclude='./.pytest_cache' \
  --exclude='./__pycache__' \
  -C "$project_directory" -cf - . |
  tar -C "$local_build_directory" -xf -

printf '%s\n' "Собираем и запускаем сервис…"
docker compose \
  --project-directory "$local_build_directory" \
  --file "$local_build_directory/docker-compose.yml" \
  up --build --detach

attempt=0
while [ "$attempt" -lt 60 ]; do
  if curl --fail --silent --show-error \
      "http://localhost:${api_port}/api/health" >/dev/null 2>&1 \
    && curl --fail --silent --show-error \
      "http://localhost:${web_port}/" >/dev/null 2>&1; then
    printf '\n%s\n%s\n%s\n' \
      "Сервис готов." \
      "Открыть интерфейс: http://localhost:${web_port}" \
      "Документация API: http://localhost:${api_port}/docs"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 2
done

printf '%s\n' \
  "Сервис запущен, но не успел подтвердить готовность." \
  "Проверьте состояние командой: docker compose ps"
docker compose ps
exit 1
