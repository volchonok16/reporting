# Деплой на pallink.fun

## Требования

- Ubuntu/Debian VPS
- Docker + Docker Compose
- DNS: `pallink.fun`, `www.pallink.fun`, `api.pallink.fun` → IP сервера
- Порты `8000` и `5173` на localhost свободны (backend и frontend)

> На том же сервере не должно работать другое приложение на `:8000` / `:5173` (например, старый roadmap).

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

## Продление сертификата

```bash
sudo certbot renew --dry-run
sudo systemctl reload nginx
```

Cron (обычно ставится certbot автоматически): `certbot renew`

## Ручной выпуск сертификата

Если автоматический выпуск не сработал:

```bash
sudo certbot certonly --webroot -w /var/www/certbot \
  -d pallink.fun -d www.pallink.fun -d api.pallink.fun
sudo bash scripts/production.sh
```
