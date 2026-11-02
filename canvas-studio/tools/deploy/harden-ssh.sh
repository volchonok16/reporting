#!/usr/bin/env bash
# Turns off password logins over SSH once a key works (run after deploy.sh --install-key).
#   tools/deploy/harden-ssh.sh root@203.0.113.10
set -euo pipefail
TARGET="${1:?Укажите сервер: user@host}"
# One connection with retries, as in deploy.sh: bots in the pre-login slots drop some new ones.
CTL="$(mktemp -u /tmp/cs-ssh.XXXXXX)"
trap 'ssh -o ControlPath="$CTL" -O exit "$TARGET" 2>/dev/null' EXIT
# Refuse if the key does not work: otherwise we would lock ourselves out.
ok=0
for i in 1 2 3 4 5; do
  ssh -o BatchMode=yes -o ConnectTimeout=25 -o ControlPath="$CTL" -o ControlMaster=yes -o ControlPersist=5m -fN "$TARGET" && { ok=1; break; }
  sleep 3
done
[ "$ok" = 1 ] || { echo "Вход по ключу не работает — пароль не отключаю" >&2; exit 1; }
ssh -o ControlPath="$CTL" "$TARGET" 'set -e
cat > /etc/ssh/sshd_config.d/10-canvas-hardening.conf <<CONF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
# Password-guessing bots hold the slots before login: let them go sooner, keep more room
# (deploys timed out at «banner exchange», 26 October).
LoginGraceTime 20
MaxStartups 30:50:100
CONF
sshd -t && (systemctl reload ssh 2>/dev/null || systemctl reload sshd)
sshd -T | grep -Ei "^(passwordauthentication|permitrootlogin|logingracetime|maxstartups) "'
echo "Вход по паролю отключён, остался только вход по ключу."
