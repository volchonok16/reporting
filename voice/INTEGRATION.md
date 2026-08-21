# Voice в reporting

Каталог `voice/` — приложение «Агент мобильной карусели», встроенное во вкладку **Voice** reporting.

- Docker Compose (корень reporting): сервисы `voice-api` (`:8100`) и `voice-web` (`:3100`, UI по пути `/voice/`)
- `voice-web` собирается с `VOICE_BASE_PATH=/voice` — ассеты и роуты под `/voice/…`
- Frontend reporting открывает same-origin iframe `/voice/?reportingSso=…&embed=1&theme=…`
- Прокси: host nginx → `:5173` → `voice-web` / `voice-api` (`/voice-api/`)
- Маркер: `GET /voice/reporting-voice.txt` → `voice-ok`
- **Один логин:** reporting → `POST /api/voice/sso-token` → iframe → `POST /api/auth/reporting-sso` (`VOICE_SSO_SECRET`)
- Пользователи с `org_user.voice_only = true` видят только вкладку Voice
- Прямой доступ вне iframe: `http://localhost:3100/voice/`
- **Мастер-файл** хранится в PostgreSQL reporting (`master_*`, миграция `050_voice_master.sql`); `voice-api` → `DATABASE_URL` / `VOICE_DATABASE_URL`. Auth/uploads/jobs — SQLite в `voice/data`
- CSV-заголовок мастер-файла: `order=cap_idp_location_number&CAP_DRN_CLD&CAP_DRN_CLD_BCD&cap_idp_calling_party_number`
- Комментарий к записи мастер-файла: до **50000** символов
