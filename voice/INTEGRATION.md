# Voice в reporting

Каталог `voice/` — приложение «Агент мобильной карусели», встроенное во вкладку **Voice** reporting.

- Docker Compose (корень reporting): сервисы `voice-api` (`:8100`) и `voice-web` (`:3100`)
- Frontend reporting открывает `VITE_VOICE_APP_URL` (по умолчанию `http://localhost:3100`) в iframe
- Собственная авторизация Voice (SQLite `voice/data/registry.sqlite3`) независима от reporting
- Пользователи reporting с `org_user.voice_only = true` видят только вкладку Voice
