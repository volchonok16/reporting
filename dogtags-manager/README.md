# Dogtags Manager внутри Reporting

Интерфейс открывается во вкладке после Voice, через `/dogtags-manager/` на том же домене, что и Reporting. Пользователь входит в Reporting; каждый запрос `/api/dogtags-manager/` проверяет его сессию и право доступа к вкладке.

## Автономная установка для t2product.ru

В репозиторий включены backend и контракты Dogtags из коммита `534b82f990bc36cf5356ded56e6511d52d1c6dc5`, а также адаптированный интерфейс. Отдельный исходный проект DOGTAGS MANAGER и его работающие контейнеры для этой установки не нужны.

`compose.yml` в этой папке запускает собственные API, worker, dispatcher, PostgreSQL 17 и RabbitMQ. Миграции выполняет одноразовый сервис `init`; на пустой установке он публикует исходные правила обработки. Существующие опубликованные правила и архив он не заменяет. Проект Docker по умолчанию называется `reporting-dogtags`, volumes принадлежат только ему. Источники, результаты и scratch хранятся отдельно от Reporting, Voice, MinIO и других установок Dogtags.

Наружу не публикуются порты API, PostgreSQL и RabbitMQ. Только Reporting backend подключается к выделенной сети gateway; базы и очередь остаются в другой, внутренней сети. API доверяет proxy headers только в этой закрытой схеме; не подключайте посторонние контейнеры к gateway. Worker ограничен двумя CPU и 4 GiB по умолчанию; эти лимиты настраиваются отдельно от остальных приложений.

Обновление и остановка проекта `reporting-dogtags` не перезапускают Voice, Canvas и остальные приложения. Для открытия вкладки по-прежнему нужны доступный Reporting, его авторизация и общий nginx. Внутри Dogtags сохраняется общее рабочее пространство для пользователей с доступом к вкладке.

### Настройки

В корневом `.env` Reporting задайте реальные отдельные пароли:

```dotenv
DOGTAGS_MANAGER_ORIGIN=https://t2product.ru
REPORTING_DOGTAGS_POSTGRES_PASSWORD=<отдельный случайный пароль БД>
REPORTING_DOGTAGS_RABBITMQ_PASSWORD=<отдельный случайный пароль RabbitMQ>
REPORTING_DOGTAGS_NETWORK=reporting-dogtags-gateway
```

`DOGTAGS_MANAGER_URL` в интеграционном override фиксируется как `http://reporting-dogtags-api:8000`: это адрес API внутри Docker. `DOGTAGS_MANAGER_ORIGIN` задаёт согласованные Origin, Host и схему запроса к API; Compose Dogtags использует его же как APP_ORIGIN. Это не URL подключения. У API включена обработка доверенных proxy headers, поэтому HTTPS-origin работает и при внутреннем HTTP-соединении. Reporting не пересылает произвольный X-Forwarded-Proto браузера.

Для тестирования на localhost используйте `DOGTAGS_MANAGER_ORIGIN=http://127.0.0.1:8000` в отдельном локальном env-файле. Это допустимый внутренний origin; публичные порты Dogtags от этого не появляются. Для контурного адреса требуется HTTPS: сам Dogtags запрещает нелокальный HTTP-origin.

### Запуск с доступом к образам

Все команды ниже выполняются из корня `reporting`. Требуется Docker Compose v2.

```bash
docker compose --env-file .env -p reporting-dogtags \
  -f dogtags-manager/compose.yml up -d --build
```

После появления здорового API добавьте `-f docker-compose.dogtags.yml` **последним** в штатную команду Compose Reporting. Сохраните текущий project name, env-файл и все остальные override-файлы — иначе можно выбрать другие volumes Reporting. Пример для обычного production:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  -f docker-compose.dogtags.yml up -d --build backend
```

Reporting backend нужно пересобрать для передачи HTTPS-схемы. Если обновляется первоначальная интеграция, backend/frontend также должны уже содержать новую вкладку и её nginx-конфигурацию.

### Закрытый контур

На машине с доступом к зависимостям соберите дополнительный bundle для архитектуры сервера:

```bash
bash scripts/dogtags-bundle.sh dist/reporting-dogtags.tar linux/amd64
```

Передайте архив и эту версию исходников в контур. Обычный Reporting offline bundle и этот bundle поставляются вместе; первый не включает Dogtags автоматически.

```bash
docker load -i /tmp/reporting-dogtags.tar
docker compose --env-file .env -p reporting-dogtags \
  -f dogtags-manager/compose.yml -f dogtags-manager/compose.offline.yml \
  up -d --no-build --pull never
```

Затем к штатной offline-команде Reporting добавьте последним `-f docker-compose.dogtags.yml` и пересоздайте backend из обновлённого Reporting bundle с `--no-build --pull never`. Для последующих обновлений существующей БД сначала сделайте согласованный backup БД и volumes; `init` применяет миграции вперёд. Не используйте `down -v` для рабочих данных.

### Проверка

```bash
docker compose --env-file .env -p reporting-dogtags \
  -f dogtags-manager/compose.yml ps -a
docker compose --env-file .env -p reporting-dogtags \
  -f dogtags-manager/compose.yml exec api python -c \
  "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/api/health').read().decode())"
```

`init` должен завершиться с кодом 0, API/PostgreSQL/RabbitMQ — быть healthy, worker и dispatcher — работать. На `https://t2product.ru` войдите в Reporting, откройте вкладку, загрузите синтетический CSV, дождитесь обработки и скачайте результат. Без сессии Reporting API вкладки должен отвечать 401/403. Архив новой установки первоначально пустой; локальные файлы и историю прежнего самостоятельного Dogtags эта схема не переносит.

## Разработка и тесты

- Reporting gateway: `PYTHONPATH=backend python -m unittest discover -s backend/tests -p test_dogtags_proxy.py -v`.
- UI: в `dogtags-manager/frontend/` выполните `npm ci`, `npm run build`, `node --test tests/unit/*.test.mjs` на Node.js 24.
- Тесты оригинального backend сохранены в `dogtags-manager/backend/tests/`; production-образ не включает их и dev-зависимости.
- PDF-ресурсы копируются из закреплённой зависимости `pdfjs-dist` при сборке; данные, секреты и Docker bundles в Git не включаются.

Существующие ошибки общего TypeScript-check Reporting в других разделах этим изменением не исправляются.

[Local verification and bootstrap regression](verification.md).
