# Проверка интеграции Dogtags по принципу Voice — 27 ноября 2026

## Как встроен Voice

`backend/app/voice_integration.py` монтирует Carousel FastAPI на `/voice-api` и включает его executor в lifecycle Reporting. `frontend/src/Voice.tsx` открывает `/voice/` в iframe, проверяет upstream, получает короткий токен `/api/voice/sso-token` и передаёт его через postMessage. Carousel проверяет подпись и выдаёт собственную bearer-сессию. Интерфейс собирается как `voice-web` штатным Compose; по умолчанию backend использует PostgreSQL Reporting и свои таблицы, а файлы — рабочий каталог Voice.

## Что приведено к общему принципу

Dogtags теперь входит в тот же Compose-проект Reporting: API, worker, dispatcher, init, PostgreSQL и RabbitMQ подключаются через `REPORTING_DOGTAGS_ENABLED=1`. Штатные dev/prod/offline/corp-direct режимы подключают модуль автоматически. Его образы включаются в общий offline-bundle Reporting. Отдельный Compose-проект, глобальная gateway-сеть и отдельный bundle больше не требуются.

Авторизация остаётся проверкой текущей сессии Reporting на каждом запросе. В соответствии с ответом пользователя сохранён общий архив. Python-окружение Dogtags, его БД, очередь, файлы и private-сеть отделены от Voice и других модулей; общий backend не ждёт API Dogtags при старте.

## Проверено локально

- Reporting backend, Voice и Dogtags API работают в одном Compose project `b2prod` из папки `reporting`. Предыдущие отдельные контейнеры Dogtags остановлены; их volumes сохранены.
- Перед переключением сделаны backup БД и файлов. До новых тестовых загрузок совпали количество intake-записей и правил; SHA-256 полного tar существующих файлов остался тем же. Локальный override подключает прежние volumes через external и сохраняет hostname RabbitMQ.
- Через Reporting выполнены вход, проверка ACL (без сессии 401), загрузка синтетического CSV, реальная обработка worker до PREPARED, approval и скачивание всех результатов с проверкой размера и SHA-256. Синтетическая запись удалена штатным API; видимый архив вернулся к прежнему состоянию.
- При остановленном API Dogtags Reporting и Voice отвечали 200. Полностью прошли выдача SSO-токена Voice, обмен на bearer-сессию и запрос `/api/auth/me`. Только вкладка Dogtags получала 502. После проверки её API восстановлен.
- Образы Dogtags, его PostgreSQL и RabbitMQ прошли docker save/load. Через штатный offline-режим общего Compose его сервисы запущены с `--no-build --pull never`.
- Новые deployment-тесты: 5/5. Проверены выключенный модуль без новых секретов, единый проект с отдельными сетями/volumes и отсутствием host-портов, прежняя конфигурация Voice, offline-образы и выбранный env/local override, комментарии/кавычки dotenv и явное отклонение неверного флага. До изменения скриптов три новых сценария падали. Bash-синтаксис изменённых скриптов проверен.

## Ранее проверенное и ограничения

В предыдущем этапе прошли 8 тестов шлюза Reporting (включая HTTPS и запрет подмены схемы браузером) и bootstrap-тест в отдельной PostgreSQL schema: повторный запуск сохраняет отличающиеся активные правила и владельца. Их Python-код этой доработкой не менялся.

Domain-тесты исходного Dogtags и перенесённого backend дают одинаковые 227 passed / 29 failed на Git-снимке `534b82f`. Эти исходные ошибки и существующие ошибки общего TypeScript-check Reporting не исправлялись. Бизнес-алгоритмы и контракты файлов не менялись.

Сам сервер t2product.ru, его TLS/nginx и ресурсы не проверялись и не менялись. Полная сборка всего общего bundle для целевой архитектуры сервера в этой проверке не выполнялась: проверены конфигурация и offline-перенос образов Dogtags на локальной архитектуре. Перед выкладкой нужен полный общий bundle и проверка на целевом стенде.

## Повторить проверки

```bash
python3 -m unittest discover -s scripts/tests -p test_dogtags_deployment.py -v

export COMPOSE_ENV_FILE=.env.local
source scripts/resolve-compose.sh dev
"${COMPOSE[@]}" ps -a
"${COMPOSE[@]}" run --rm --no-deps \
  -v "$PWD/dogtags-manager/tests:/tests:ro" dogtags-init \
  python -m unittest discover -s /tests -v
```

Bootstrap-тест создаёт и удаляет только случайную тестовую схему; рабочие таблицы не изменяет. Все команды выполняются из корня `reporting`.

Code review завершён: один подтверждённый P2 в разборе inline-комментариев исправлен. Используется разбор окружения самим Compose; регрессионные случаи сначала воспроизвели ошибку, затем прошли. Проверены переходы Voice → Dogtags в браузере без второго логина.
