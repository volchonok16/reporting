# Voice в reporting

Каталог `voice/` — приложение «Агент мобильной карусели», встроенное во вкладку **Voice** reporting.

- Docker Compose (корень reporting): сервисы `voice-api` (`:8100`) и `voice-web` (`:3100`)
- Frontend reporting открывает `VITE_VOICE_APP_URL` в iframe с SSO-токеном
- **Один логин:** пользователь входит в reporting → `POST /api/voice/sso-token` → iframe → `POST /api/auth/reporting-sso` (общий секрет `VOICE_SSO_SECRET`)
- Пользователи reporting с `org_user.voice_only = true` видят только вкладку Voice
- Локальные учётки карусели остаются для прямого доступа к `:3100` вне reporting
