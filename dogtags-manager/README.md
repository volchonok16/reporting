# Dogtags Manager — модуль Reporting

Dogtags открывается во вкладке после Voice на том же домене Reporting: `/dogtags-manager/`. Пользователь входит один раз в Reporting; каждый запрос `/api/dogtags-manager/` проверяет его текущую сессию и право на вкладку. Отдельного логина Dogtags нет. Архив остаётся общим для пользователей с доступом, как согласовано для этой интеграции.

## Принцип интеграции и сравнение с Voice/Carousel

Оба приложения входят в исходники Reporting, открываются через iframe на одном домене, используют его вход и тему, запускаются штатным Compose и поставляются в общем offline-bundle. Внешнее приложение на компьютере разработчика для их работы не требуется.

| Часть | Voice / Carousel | Dogtags Manager |
| --- | --- | --- |
| Интерфейс | `/voice/`, отдельный `voice-web` | `/dogtags-manager/`, статика в образе Reporting backend |
| API | FastAPI sub-application `/voice-api` внутри Reporting backend | служебный `dogtags-api` внутри того же Compose, доступ через авторизованный `/api/dogtags-manager/` |
| Вход | короткий подписанный SSO-токен Reporting → bearer-сессия Voice | проверка текущей сессии Reporting шлюзом на каждом запросе |
| Обработка | executor Carousel внутри Reporting backend | отдельные worker и dispatcher Dogtags |
| Данные | таблицы PostgreSQL Reporting по умолчанию; возможен VOICE_DATABASE_URL | собственные PostgreSQL 17, RabbitMQ и volumes |

Это общий принцип встраивания, а не объединение несовместимых Python-окружений: Reporting использует FastAPI 0.124 / SQLAlchemy 2.0, Dogtags — FastAPI 0.143 / SQLAlchemy 2.1 и собственный lockfile. Контейнер Dogtags сохраняет эти зависимости отдельно и не изменяет зависимости Voice или остальных модулей.

Исходники backend и контракты перенесены из Dogtags `534b82f990bc36cf5356ded56e6511d52d1c6dc5`. Его прежняя папка и отдельно запущенная установка не используются.

## Настройки для t2product.ru

В используемом сервером корневом `.env`:

```dotenv
REPORTING_DOGTAGS_ENABLED=1
DOGTAGS_MANAGER_ORIGIN=https://t2product.ru
REPORTING_DOGTAGS_POSTGRES_PASSWORD=<отдельный случайный пароль БД>
REPORTING_DOGTAGS_RABBITMQ_PASSWORD=<отдельный случайный пароль очереди>
```

Для существующих установок модуль выключен по умолчанию: остальные приложения запускаются без новых паролей. `scripts/resolve-compose.sh` при включении добавляет `docker-compose.dogtags.yml`, а в offline/corp-direct — ещё `docker-compose.dogtags.offline.yml`. Для модуля требуется Docker Compose v2.

`DOGTAGS_MANAGER_URL` автоматически задаётся как `http://dogtags-api:8000`, внутренний адрес сервиса. Его не нужно заменять публичным доменом. `DOGTAGS_MANAGER_ORIGIN` — согласованное значение Origin/Host и схемы запроса для проверки Dogtags; его же Compose передаёт сервису как APP_ORIGIN. HTTPS-схему задаёт доверенный шлюз Reporting, а не заголовок браузера.

API, PostgreSQL и RabbitMQ не публикуют порты на хосте. Reporting backend и API Dogtags соединяет отдельная gateway-сеть; только Dogtags подключён к сети БД/очереди. Имена сетей и volumes по умолчанию принадлежат текущему Compose project, без общего глобального имени. Worker по умолчанию ограничен двумя CPU и 4 GiB.

## Единый запуск

Из корня `reporting`, после настройки `.env`:

```bash
bash scripts/compose-up.sh dev --build
# На production вместо dev используйте prod.
```

Команда поднимает Reporting, Voice и включённый Dogtags одним Compose-проектом. Миграции и первая публикация исходных правил Dogtags выполняются одноразовым сервисом `dogtags-init`; существующие правила и данные сохраняются. Reporting backend не зависит от успешного старта API Dogtags: недоступность этого API отображается только во вкладке.

Для локального env-файла:

```bash
COMPOSE_ENV_FILE=.env.local bash scripts/compose-up.sh dev
```

В нём можно задать `COMPOSE_PROJECT_NAME`, чтобы сохранить имя уже работающей установки, и `COMPOSE_LOCAL_OVERRIDE=docker-compose.local.yml` для локальных портов/volumes. Такой override применяется последним, игнорируется Git и не передаётся на сервер. Локальный origin может быть `http://127.0.0.1:8000`: это внутренний параметр проверки API, публичных портов Dogtags он не создаёт. Для нелокального origin сам Dogtags требует HTTPS.

## Общая offline-поставка

На машине с доступом к зависимостям включите модуль в конфигурации сборки. Для архитектуры сервера:

```bash
bash scripts/offline-bundle.sh dist/reporting-offline.tar linux/amd64
```

В один архив автоматически войдут также образы Dogtags API/worker, его PostgreSQL и RabbitMQ. Отдельного Dogtags bundle и второго Compose-проекта больше нет. На сервер передаются исходники этой версии и общий архив; в серверном `.env` модуль также должен быть включён:

```bash
sudo bash scripts/offline-deploy.sh /tmp/reporting-offline.tar --with-ssl --t2product --tunnel
```

Нужны заранее подготовленные TLS-сертификаты и рабочие настройки Reporting. Не передавайте локальный override, секреты, архивы заявок и Docker volumes через Git.

## Обновление существующей отдельной установки

Перед переходом остановите её новые задания и сделайте согласованный backup БД и файлов. Остановите прежние API/worker/dispatcher до подключения тех же данных в общем Compose, затем БД и RabbitMQ. В отдельном локальном/server override сопоставьте `dogtags-postgres-data`, `dogtags-rabbitmq-data`, `dogtags-artifacts` и `dogtags-scratch` существующим volumes через `external: true` и их точные имена. Сохраните прежние пароли, а при переносе RabbitMQ — его прежний hostname/node identity. Это позволяет использовать те же данные без копирования в пустую базу.

На новой установке override с external volumes не нужен: Compose создаёт отдельные volumes этого проекта. Не выполняйте `down -v` для рабочих данных. При будущих миграциях сначала делайте backup: `dogtags-init` применяет миграции вперёд.

## Проверка

```bash
source scripts/resolve-compose.sh prod
"${COMPOSE[@]}" ps -a
"${COMPOSE[@]}" exec dogtags-api python -c \
  "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/api/health').read().decode())"
```

`dogtags-init` должен завершиться с кодом 0; API/PostgreSQL/RabbitMQ — быть healthy; worker и dispatcher — работать. Войдите в Reporting на `https://t2product.ru`, откройте вкладку, обработайте синтетический CSV и скачайте результат. Без сессии Reporting API вкладки должен отвечать 401/403.

Проверки графа запуска: `python3 -m unittest discover -s scripts/tests -p test_dogtags_deployment.py -v` (требуется Docker Compose; контейнеры не запускаются). Проверки шлюза: `PYTHONPATH=backend python -m unittest discover -s backend/tests -p test_dogtags_proxy.py -v`. Остальные результаты и ограничения: [verification.md](verification.md).

Исходные domain-тесты Dogtags и общий TypeScript-check Reporting имеют ранее обнаруженные ошибки; они не исправлялись этой интеграцией.
