#!/usr/bin/env bash
# Deploys Simmetrika (canvas-studio) to a VPS over SSH: builds the web app, uploads a new
# release and runs remote-setup.sh there (Node, systemd, nginx, HTTPS, firewall,
# backups). Run it again to update; the previous five releases stay for rollback.
#
# A new server is one command: the root password in CS_SSH_PASSWORD (handed to ssh through
# SSH_ASKPASS, never written to a file) — the script puts this computer's SSH key there,
# sets everything up, asks for the secrets (mail, the AI key) while the server has none,
# and turns password logins off once the key works:
#   CS_SSH_PASSWORD='…' tools/deploy/deploy.sh root@203.0.113.10 --domain design.example.com
# An update is the same without the password; it asks nothing:
#   tools/deploy/deploy.sh root@203.0.113.10 [--domain design.example.com] [--www] [--redirect-from old.example.com]… [--email admin@example.com] [--closed]
#
#   --env FILE         the secrets from a file instead of questions (replaces the server's /etc/canvas-studio/env)
#   --keep-password    leave password logins on
#   --install-key      only copy the SSH key (the old first step; deploy now does it itself)
set -euo pipefail

TARGET="${1:?Укажите сервер: user@host}"
shift
INSTALL_KEY=0
ENV_FILE=""
HARDEN=1
SETUP_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --install-key) INSTALL_KEY=1; shift ;;
    --env) ENV_FILE="$2"; shift 2 ;;
    --keep-password) HARDEN=0; shift ;;
    --domain|--email|--redirect-from) SETUP_ARGS+=("$1" "$2"); shift 2 ;;
    --closed|--www) SETUP_ARGS+=("$1"); shift ;;
    *) echo "Неизвестный параметр: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[ -z "$ENV_FILE" ] || [ -f "$ENV_FILE" ] || { echo "Нет файла с секретами: $ENV_FILE" >&2; exit 2; }
# The build and the tests run here: Node.js 22.13+ (type stripping for .ts).
NODE_V="$(node -p 'process.versions.node' 2>/dev/null || echo 0)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null \
  || { echo "Нужен Node.js 22.13 или новее на этом компьютере (сейчас: $NODE_V) — https://nodejs.org" >&2; exit 2; }
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=20 -o ConnectTimeout=15)

# Password via SSH_ASKPASS (no sshpass needed, nothing stored on disk but a tiny helper that reads the variable).
ASKPASS=""
cleanup() { [ -z "$ASKPASS" ] || rm -f "$ASKPASS"; }
trap cleanup EXIT
if [ -n "${CS_SSH_PASSWORD:-}" ]; then
  ASKPASS="$(mktemp)"
  printf '#!/bin/sh\nprintf "%%s\\n" "$CS_SSH_PASSWORD"\n' > "$ASKPASS"
  chmod 700 "$ASKPASS"
  export SSH_ASKPASS="$ASKPASS" SSH_ASKPASS_REQUIRE=force DISPLAY="${DISPLAY:-:0}"
fi
run() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }
# One connection for every step, opened with retries: password-guessing bots fill the server's
# pre-login slots and it drops some new connections at «banner exchange» (28 October: 1 in 3).
CTL="$(mktemp -u /tmp/cs-ssh.XXXXXX)"
SSH_OPTS+=(-o ControlPath="$CTL")
trap 'ssh -o ControlPath="$CTL" -O exit "$TARGET" 2>/dev/null; cleanup' EXIT
SSH_ERR="$(mktemp)"
trap 'ssh -o ControlPath="$CTL" -O exit "$TARGET" 2>/dev/null; rm -f "$SSH_ERR"; cleanup' EXIT
# Returns 0 — connected; 1 — the server did not answer; 2 — it answered but refused the login
# (no point retrying: a new server without this computer's key). `key` — the key only, no password.
connect() {
  local only=()
  [ "${1:-}" = key ] && only=(-o BatchMode=yes)
  for i in 1 2 3 4 5; do
    ssh "${SSH_OPTS[@]}" ${only[@]+"${only[@]}"} -o ControlMaster=yes -o ControlPersist=10m -fN "$TARGET" 2>"$SSH_ERR" && return 0
    grep -qi 'permission denied' "$SSH_ERR" && return 2
    [ "$i" = 5 ] || echo "Сервер не ответил, попытка $((i + 1)) из 5…" >&2
    sleep 3
  done
  cat "$SSH_ERR" >&2
  return 1
}
disconnect() { ssh -o ControlPath="$CTL" -O exit "$TARGET" 2>/dev/null || true; }
KEY="$HOME/.ssh/id_ed25519"
# This computer's key on the server, logging in with the password once.
install_key() {
  [ -f "$KEY.pub" ] || ssh-keygen -t ed25519 -N '' -f "$KEY" -C "canvas-studio-deploy"
  run "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && grep -qxF '$(cat "$KEY.pub")' ~/.ssh/authorized_keys || echo '$(cat "$KEY.pub")' >> ~/.ssh/authorized_keys"
}

if [ "$INSTALL_KEY" = 1 ]; then
  connect || { echo "Не удалось войти на сервер" >&2; exit 1; }
  install_key
  echo "Ключ установлен. Дальше вход без пароля. Отключить вход по паролю: tools/deploy/harden-ssh.sh $TARGET"
  exit 0
fi

echo "==> Проверка и сборка"
cd "$ROOT"
node --test "packages/*/test/*.test.ts" >/dev/null 2>&1 || { echo "Тесты не прошли — выкладка отменена (npm test покажет подробности)" >&2; exit 1; }
npm run --silent build

echo "==> Вход на сервер"
[ -f "$KEY.pub" ] || ssh-keygen -q -t ed25519 -N '' -f "$KEY" -C "canvas-studio-deploy"
set +e; connect key; got=$?; set -e
if [ "$got" = 2 ]; then
  # A new server: once with the password, to put the key there; from then on by the key.
  [ -n "${CS_SSH_PASSWORD:-}" ] || { echo "Сервер не пускает по ключу этого компьютера. Новый сервер — запустите с паролем root: CS_SSH_PASSWORD='…' $0 $TARGET …" >&2; exit 1; }
  connect || { echo "Не удалось войти по паролю — выкладка отменена" >&2; exit 1; }
  install_key
  disconnect
  connect key || { echo "Ключ положен, но вход по нему не работает — выкладка отменена (пароль не трогал)" >&2; exit 1; }
  echo "Ключ этого компьютера положен на сервер, дальше вход по ключу."
elif [ "$got" != 0 ]; then
  echo "Сервер не принимает подключения — выкладка отменена" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
RELEASE="/opt/canvas-studio/releases/$STAMP"
echo "==> Загрузка версии $STAMP"
# Only what the server needs: the built web app, the server code and the document core (live editing).
# COPYFILE_DISABLE: no macOS "._*" metadata files in the archive.
COPYFILE_DISABLE=1 tar -czf - dist package.json apps/server packages/server packages/core/src tools/deploy/remote-setup.sh \
  | run "mkdir -p '$RELEASE' && tar -xzf - -C '$RELEASE'"

echo "==> Нейросеть «Удалить фон»"
# Heavy files (apps/web/heavy, 70 MB) are not in the release: each goes once into /opt/canvas-studio/heavy.
# Their names carry a version or a hash, so a file that is there is the right one; a new version is a new name.
if [ -d apps/web/heavy ]; then
  HAVE="$(run 'cd /opt/canvas-studio/heavy 2>/dev/null && find . -type f | sed "s|^\./||"' || true)"
  ( cd apps/web/heavy && find . -type f ! -name '.*' | sed 's|^\./||' ) | while read -r f; do
    if ! printf '%s\n' "$HAVE" | grep -qxF "$f"; then
      echo "    $f ($(du -h "apps/web/heavy/$f" | cut -f1))"
      run "mkdir -p \"/opt/canvas-studio/heavy/\$(dirname '$f')\" && cat > '/opt/canvas-studio/heavy/$f.part' && mv '/opt/canvas-studio/heavy/$f.part' '/opt/canvas-studio/heavy/$f'" < "apps/web/heavy/$f"
    fi
  done
fi

echo "==> Настройка сервера"
run "bash '$RELEASE/tools/deploy/remote-setup.sh' '$RELEASE' ${SETUP_ARGS[*]:-}"

# Secrets: from --env, or asked while the server has none (a new one); an update asks nothing.
restart_and_check() {
  run 'systemctl restart canvas-studio
for i in $(seq 1 20); do curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS http://127.0.0.1:8080/api/health >/dev/null || { echo "Сервер не поднялся после смены секретов: journalctl -u canvas-studio -n 50" >&2; exit 1; }
journalctl -u canvas-studio -n 20 --no-pager -o cat | grep -E "^(Почта|Макеты по описанию)" | tail -2'
}
if [ -n "$ENV_FILE" ]; then
  echo "==> Секреты из $ENV_FILE"
  run "umask 077 && cat > /etc/canvas-studio/env" < "$ENV_FILE"
  restart_and_check
elif ! run '[ -s /etc/canvas-studio/env ]'; then
  if [ -t 0 ]; then
    echo "==> Секреты (на сервере их ещё нет). Ввод пароля и ключа не виден. Пустой ответ — пропустить."
    # A value in quotes for systemd's EnvironmentFile: «"», «\» and spaces in a password stay as typed.
    q() { local v="${1//\\/\\\\}"; v="${v//\"/\\\"}"; printf '"%s"' "$v"; }
    read -r -p "Ящик для писем (например no-reply@simmetrika.online): " MAIL_USER
    MAIL=""
    if [ -n "$MAIL_USER" ]; then
      read -r -s -p "Пароль от ящика: " MAIL_PASS; echo
      read -r -p "SMTP-сервер [smtp.beget.com]: " MAIL_HOST
      read -r -p "Порт [465]: " MAIL_PORT
      MAIL_PORT="${MAIL_PORT:-465}"
      MAIL_SECURE=ssl; [ "$MAIL_PORT" = 465 ] || MAIL_SECURE=tls
      MAIL="CS_SMTP_HOST=${MAIL_HOST:-smtp.beget.com}
CS_SMTP_PORT=$MAIL_PORT
CS_SMTP_SECURE=$MAIL_SECURE
CS_SMTP_USER=$MAIL_USER
CS_SMTP_PASS=$(q "$MAIL_PASS")
CS_MAIL_FROM=$MAIL_USER
CS_MAIL_FROM_NAME=Симметрика
"
    fi
    read -r -s -p "Ключ нейросети (CS_AI_KEY, нейрошлюз Beget): " AI_KEY; echo
    if [ -n "$MAIL$AI_KEY" ]; then
      { printf '%s' "$MAIL"; [ -z "$AI_KEY" ] || printf 'CS_AI_KEY=%s\n' "$(q "$AI_KEY")"; } | run "umask 077 && cat > /etc/canvas-studio/env"
      unset MAIL_PASS AI_KEY MAIL
      restart_and_check
    fi
    [ -n "$MAIL_USER" ] || echo "Почта не задана: коды восстановления пароля будут только в журнале сервера."
  else
    echo "Внимание: секретов на сервере нет — почта и нейросеть выключены. Запустите в терминале (спросит) или с --env файл; что в нём — docs/DEPLOY.md, «Почта» и «Нейросеть»." >&2
  fi
fi

# Password logins off, once the key is known to work (harden-ssh.sh checks it with a new connection).
if [ "$HARDEN" = 1 ] && ! run "sshd -T 2>/dev/null | grep -qi '^passwordauthentication no'"; then
  echo "==> Вход по паролю"
  "$ROOT/tools/deploy/harden-ssh.sh" "$TARGET" >/dev/null
  echo "Вход по паролю отключён, остался только вход по ключу (--keep-password — оставить)."
fi
echo "Готово."
