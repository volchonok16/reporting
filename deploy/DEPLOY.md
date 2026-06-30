# Деплой на pallink.fun

## Требования

- Ubuntu/Debian VPS
- Docker + Docker Compose (`docker compose` или `docker-compose`)
- DNS: `pallink.fun`, `www.pallink.fun`, `api.pallink.fun` → IP сервера
- Порты `8000` и `5173` на localhost свободны (backend и frontend)

> На том же сервере не должно работать другое приложение на `:8000` / `:5173` (например, старый roadmap).

## Docker Compose

На сервере часто используется классический **`docker-compose`** (через дефис). Скрипты подхватывают его автоматически; можно явно задать в `.env`:

```env
COMPOSE_CMD=docker-compose
```

### Только Docker (без nginx) — вручную

**Обычное обновление на сервере** (git pull + пересборка + туннель PostgreSQL для DBeaver):

```bash
cd /var/database/reporting
bash scripts/up.sh prod
```

Эквиваленты:

```bash
bash scripts/prod.sh
bash scripts/deploy-prod.sh
git pull && bash scripts/compose-up.sh prod --build --tunnel
```

Флаг `--tunnel` подключает `docker-compose.db-tunnel.yml` (проброс `127.0.0.1:5432` на хост).

Без git pull / без пересборки:

```bash
bash scripts/deploy-prod.sh --no-pull
bash scripts/compose-up.sh prod --tunnel          # только перезапуск
bash scripts/compose-up.sh prod --tunnel postgres # только postgres (как db-tunnel.sh)
```

Логи:

```bash
docker-compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.db-tunnel.yml ps
docker-compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.db-tunnel.yml logs -f backend
```

### Ошибки docker-compose 1.29 (`ContainerConfig`, `KeyError: 'id'`)

Старый `docker-compose` 1.29 несовместим с новым Docker Engine: падает при **пересоздании** контейнеров (`ContainerConfig`) и в фоновом потоке логов (`KeyError: 'id'` в `watch_events`).

Скрипт `scripts/compose-up.sh` обходит `ContainerConfig` для v1: сначала `docker rm` старых контейнеров, затем обычный `up -d`. Всё равно лучше перейти на Compose v2.

**Быстрый фикс — пересобрать frontend:**

```bash
# удалить ВСЕ контейнеры frontend (в т.ч. ba5e359e8f7c_reporting-frontend)
docker ps -aq --filter "name=reporting-frontend" | xargs -r docker rm -f
bash scripts/rebuild-frontend.sh
```

Или одной командой без git pull:

```bash
docker ps -aq --filter "name=reporting-frontend" | xargs -r docker rm -f
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build --no-deps frontend
```

**Или обновить Compose (рекомендуется):**

```bash
sudo apt-get install -y docker-compose-plugin
# в .env заменить на:
# COMPOSE_CMD=docker compose
docker compose version
```

### Полный production (Docker + nginx + certbot)

```bash
sudo bash scripts/production.sh
```

Если ошибка `unknown shorthand flag: 'f'` — в `.env` добавьте `COMPOSE_CMD=docker-compose` или установите пакет:

```bash
sudo apt-get install -y docker-compose
docker-compose --version
```

## Ошибка ERR_CONNECTION_REFUSED

Браузер не может подключиться — на сервере не слушает порт 80/443. Проверьте по шагам:

```bash
# 1. DNS указывает на этот сервер?
dig +short pallink.fun
curl -4 ifconfig.me   # IP сервера — должны совпадать

# 2. nginx запущен?
sudo systemctl status nginx
sudo ss -tlnp | grep -E ':80|:443'

# 3. docker-compose в .env
grep COMPOSE_CMD .env   # должно быть: COMPOSE_CMD=docker-compose

# 4. контейнеры подняты?
docker-compose -f docker-compose.yml -f docker-compose.prod.yml ps

# 5. полный перезапуск
sudo bash scripts/production.sh
```

Если nginx работает, а сайт 502 — контейнеры не поднялись: `docker-compose ... logs backend`.

## Один скрипт

```bash
git clone https://github.com/volchonok16/reporting.git
cd reporting
cp .env.production.example .env
# Отредактируйте: пароли БД, CERTBOT_EMAIL=ваш@email.com
sudo bash scripts/production.sh
```

Скрипт:

1. Поднимает `postgres`, `backend`, `frontend` (Docker)
2. Устанавливает nginx
3. Если сертификата нет и задан `CERTBOT_EMAIL` — выпускает Let's Encrypt через certbot
4. Включает HTTPS-конфиг

## URL

| Сервис | URL |
|--------|-----|
| UI | https://pallink.fun |
| API | https://api.pallink.fun |

## Локальная разработка

```bash
bash scripts/dev.sh
```

## Автопродление сертификата

`scripts/production.sh` настраивает автопродление автоматически:

1. **Deploy-hook** — после успешного renew перезагружает nginx  
   `/etc/letsencrypt/renewal-hooks/deploy/reporting-reload-nginx.sh`
2. **systemd timer** `certbot.timer` — проверка ~2 раза в сутки (если есть в системе)
3. **Иначе cron** — `/etc/cron.d/certbot-reporting` (03:00 и 15:00 UTC)

Проверить, что всё работает:

```bash
sudo systemctl status certbot.timer    # или: cat /etc/cron.d/certbot-reporting
sudo certbot renew --dry-run
```

Ручное продление (обычно не нужно):

```bash
sudo certbot renew
sudo systemctl reload nginx
```

## Ручной выпуск сертификата

Если автоматический выпуск не сработал:

```bash
sudo certbot certonly --webroot -w /var/www/certbot \
  -d pallink.fun -d www.pallink.fun -d api.pallink.fun
sudo bash scripts/production.sh
```
