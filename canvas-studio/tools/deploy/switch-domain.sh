#!/usr/bin/env bash
# Moves Simmetrika to a new domain by itself once the domain resolves to this
# server. Runs on the server as root from cron every few minutes; does nothing
# until public DNS points the domain here, then:
#   1. gets the certificates (nothing else changes if this fails — the old
#      address keeps working and the next run tries again),
#   2. takes the mail settings from /etc/canvas-studio/env.<name> into
#      /etc/canvas-studio/env (if that file exists),
#   3. runs remote-setup.sh of the current release with the new domain, www and
#      a permanent redirect from the old address,
#   4. writes a note, removes its cron entry and (with --notify) sends a letter.
#
#   switch-domain.sh --domain simmetrika.online --from canvas.typehero.online --ip 203.0.113.10 [--notify me@example.com]
#   install: copy to /usr/local/sbin, add /etc/cron.d/simmetrika-switch:
#     */5 * * * * root /usr/local/sbin/switch-domain.sh --domain … --from … >> /var/log/simmetrika-switch.log 2>&1
set -euo pipefail

DOMAIN=""
FROM=""
NOTIFY=""
MY_IP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --from) FROM="$2"; shift 2 ;;
    --notify) NOTIFY="$2"; shift 2 ;;
    --ip) MY_IP="$2"; shift 2 ;;
    *) echo "Неизвестный параметр: $1" >&2; exit 2 ;;
  esac
done
[ -n "$DOMAIN" ] && [ -n "$FROM" ] || { echo "Нужны --domain и --from" >&2; exit 2; }

DONE="/etc/canvas-studio/switched-to-$DOMAIN"
CRON="/etc/cron.d/simmetrika-switch"
[ -f "$DONE" ] && { rm -f "$CRON"; exit 0; }
exec 9>/run/simmetrika-switch.lock
flock -n 9 || exit 0

[ -n "$MY_IP" ] || MY_IP="$(hostname -I | awk '{print $1}')"
# Both big resolvers must see it: Let's Encrypt checks from several places.
points_here() {
  local a b
  a="$(dig +short A "$1" @8.8.8.8 | tail -1)"
  b="$(dig +short A "$1" @1.1.1.1 | tail -1)"
  [ "$a" = "$MY_IP" ] && [ "$b" = "$MY_IP" ]
}
points_here "$DOMAIN" || exit 0
echo "$(date -Is) $DOMAIN указывает сюда ($MY_IP) — переключаю"

HOSTS=("$DOMAIN")
SETUP=(--domain "$DOMAIN" --redirect-from "$FROM")
if points_here "www.$DOMAIN"; then
  HOSTS+=("www.$DOMAIN")
  SETUP+=(--www)
fi

# 1. Certificates first: until they exist, nothing is changed.
for HOST in "${HOSTS[@]}"; do
  [ -d "/etc/letsencrypt/live/$HOST" ] && continue
  certbot certonly --nginx --non-interactive --agree-tos --register-unsafely-without-email --cert-name "$HOST" -d "$HOST"
done

# 2. Mail of the new domain.
NEW_ENV="/etc/canvas-studio/env.${DOMAIN%%.*}"
if [ -f "$NEW_ENV" ]; then
  [ -f "/etc/canvas-studio/env.before-$DOMAIN" ] || cp -p /etc/canvas-studio/env "/etc/canvas-studio/env.before-$DOMAIN"
  while IFS= read -r line; do
    key="${line%%=*}"
    [ -n "$key" ] || continue
    grep -v "^$key=" /etc/canvas-studio/env > /etc/canvas-studio/env.tmp || true
    printf '%s\n' "$line" >> /etc/canvas-studio/env.tmp
    install -m 600 /etc/canvas-studio/env.tmp /etc/canvas-studio/env
  done < "$NEW_ENV"
  rm -f /etc/canvas-studio/env.tmp
fi

# 3. The site on the new domain, the old address and www redirect to it.
RELEASE="$(readlink -f /opt/canvas-studio/current)"
bash "$RELEASE/tools/deploy/remote-setup.sh" "$RELEASE" "${SETUP[@]}"
curl -fsS --max-time 15 "https://$DOMAIN/api/health" >/dev/null

# 4. Done.
date -Is > "$DONE"
rm -f "$CRON"
echo "$(date -Is) готово: https://$DOMAIN"
if [ -n "$NOTIFY" ]; then
  NOTIFY="$NOTIFY" DOMAIN="$DOMAIN" FROM_HOST="$FROM" python3 - <<'PY' || echo "письмо не отправилось"
import os, smtplib, ssl
from email.message import EmailMessage
e = dict(os.environ)
# KEY=value lines as systemd reads them (values may hold spaces and ?!).
for line in open('/etc/canvas-studio/env', encoding='utf-8'):
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        k, v = line.split('=', 1)
        e[k] = v.strip().strip('"')
m = EmailMessage()
m['From'] = f"{e.get('CS_MAIL_FROM_NAME', 'Симметрика')} <{e['CS_MAIL_FROM']}>"
m['To'] = e['NOTIFY']
m['Subject'] = f"Симметрика переехала на {e['DOMAIN']}"
m.set_content(f"Сайт работает на https://{e['DOMAIN']}\n{e['FROM_HOST']} перенаправляет туда же.\nЭто письмо отправлено с новой почты — значит, и она работает.")
port = int(e.get('CS_SMTP_PORT', '465'))
if e.get('CS_SMTP_SECURE', '1') in ('1', 'true') or port == 465:
    s = smtplib.SMTP_SSL(e['CS_SMTP_HOST'], port, context=ssl.create_default_context(), timeout=30)
else:
    s = smtplib.SMTP(e['CS_SMTP_HOST'], port, timeout=30); s.starttls(context=ssl.create_default_context())
s.login(e['CS_SMTP_USER'], e['CS_SMTP_PASS'])
s.send_message(m)
s.quit()
print('письмо отправлено')
PY
fi
