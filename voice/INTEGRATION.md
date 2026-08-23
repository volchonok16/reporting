# Voice в reporting

Каталог `voice/` — приложение «Агент мобильной карусели», встроенное во вкладку **Voice** reporting.

## Архитектура

| Компонент | Где живёт |
|-----------|-----------|
| Voice API (FastAPI) | **reporting backend** — mount `/voice-api` (`backend/app/voice_integration.py`, код `voice/backend` → образ `carousel/`) |
| Voice UI (Next/vinext) | контейнер `voice-web`, путь `/voice/` |
| Мастер-файл | PostgreSQL (`master_*`, миграция `050_voice_master.sql`) |
| Uploads/jobs metadata | PostgreSQL (`voice_uploads`, `voice_jobs`, `051_voice_registry.sql`) |
| Auth | только reporting SSO (`VOICE_SSO_SECRET`), без таблиц auth в Voice |
| Файлы (uploads, workspaces) | диск `voice/data` → `/data` в backend |

## Маршруты и прокси

- Frontend reporting: iframe same-origin `/voice/?reportingSso=…&embed=1&theme=…`
- Host nginx → `:5173` (frontend-nginx) → `/voice/` → `voice-web`, `/voice-api/` → `backend:8000/voice-api/`
- Маркер: `GET /voice/reporting-voice.txt` → `voice-ok`
- SSO: reporting `POST /api/voice/sso-token` → iframe → `POST /voice-api/api/auth/reporting-sso`
- Пользователи с `org_user.voice_only = true` видят только вкладку Voice
- Прямой UI (dev): `http://localhost:3100/voice/`
- Health Voice API: `GET /voice-api/api/health` (через frontend или `:8000` напрямую)

## Docker Compose

Сервисы: `backend` (включая Voice API), `voice-web`, `frontend`, `postgres`, …  
Отдельного `voice-api` **нет** — после обновления удалите старый контейнер `reporting-voice-api`.

Prod: `BACKEND_WORKERS=1` по умолчанию (Voice job executor не шарится между uvicorn workers).

## Прочее

- CSV-заголовок мастер-файла: `order=cap_idp_location_number&CAP_DRN_CLD&CAP_DRN_CLD_BCD&cap_idp_calling_party_number`
- Комментарий к записи мастер-файла: до **50000** символов
