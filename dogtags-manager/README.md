# Dogtags Manager: запуск на сервере Reporting

Модуль доступен во вкладке Dogtags Manager на `https://t2product.ru`. Интерфейс использует `/dogtags-manager/`, запросы — `/api/dogtags-manager/`. Вход и права проверяет Reporting; отдельного логина Dogtags нет. Архив общий для пользователей с доступом к вкладке.

## Состав и изоляция

Dogtags запускается штатным Compose Reporting. Его компоненты: `dogtags-api`, `dogtags-worker`, `dogtags-dispatcher`, одноразовый `dogtags-init`, PostgreSQL 17 и RabbitMQ. Python-зависимости находятся в собственном образе и не изменяют окружение backend Reporting или Voice.

База данных, очередь и volumes Dogtags отделены от Reporting, Voice, Симметрики и Доски. API подключён к backend Reporting через выделенную gateway-сеть. PostgreSQL и RabbitMQ доступны только в private-сети Dogtags. Порты Dogtags не публикуются на хосте; пользователи работают через существующий HTTPS-вход Reporting.

## Настройки сервера

Требуются Docker Compose v2, актуальная версия репозитория Reporting и настроенный HTTPS для `t2product.ru`. Сохраните текущее имя Compose-проекта и существующие настройки Reporting. В используемый сервером корневой `.env` добавьте:

```dotenv
REPORTING_DOGTAGS_ENABLED=1
DOGTAGS_MANAGER_ORIGIN=https://t2product.ru
REPORTING_DOGTAGS_POSTGRES_PASSWORD=<отдельный случайный пароль БД>
REPORTING_DOGTAGS_RABBITMQ_PASSWORD=<отдельный случайный пароль очереди>
```

Замените значения в угловых скобках настоящими паролями. Храните `.env` на сервере с ограниченным доступом.

`DOGTAGS_MANAGER_URL` автоматически задаётся как `http://dogtags-api:8000`: это адрес контейнера в сети Compose. `DOGTAGS_MANAGER_ORIGIN` задаёт Origin/Host и HTTPS-схему для проверки запросов; то же значение передаётся API Dogtags как APP_ORIGIN. Публичный адрес Reporting и внутренний адрес API выполняют разные задачи.

Штатные скрипты подключают конфигурацию модуля при `REPORTING_DOGTAGS_ENABLED=1`. Без этого флага остальные приложения запускаются по прежней схеме, а подключение Dogtags отключено.

## Сервер в закрытом контуре

На сервере должны находиться эта версия исходников и готовый общий архив образов Reporting для архитектуры сервера. В архив должны входить также:

- `reporting/dogtags-manager:534b82f`;
- `reporting/dogtags-postgres:17`;
- `reporting/dogtags-rabbitmq:4.2`.

Отдельного архива и второго Compose-проекта Dogtags не требуется. Из корня репозитория на сервере выполните, подставив путь к полученному архиву:

```bash
sudo bash scripts/offline-deploy.sh /path/to/reporting-offline.tar --with-ssl --t2product --tunnel
```

TLS-сертификаты должны быть заранее подготовлены для серверного nginx. Скрипт загружает готовые образы и запускает общий стек без сборки и скачивания зависимостей.

## Сервер с доступом к зависимостям

Из корня репозитория на сервере:

```bash
bash scripts/compose-up.sh prod --build
sudo bash deploy/setup-nginx-ssl.sh --t2product
```

Используйте этот сценарий, если серверу разрешено получать образы и зависимости. Миграции Dogtags и первоначальную публикацию правил выполняет `dogtags-init`. Существующие правила и архив сохраняются.

## Проверка после запуска

Для закрытого контура, из корня репозитория в Bash:

```bash
source scripts/resolve-compose.sh offline-tunnel
"${COMPOSE[@]}" ps -a
"${COMPOSE[@]}" exec dogtags-api python -c \
  "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/api/health').read().decode())"
curl --fail https://t2product.ru/api/health
```

Для установки с доступом к зависимостям выберите режим `prod` вместо `offline-tunnel`. Адрес `127.0.0.1` в приведённой проверке относится к API внутри контейнера на сервере.

Ожидаемые состояния: `dogtags-init` завершён с кодом 0; API, PostgreSQL и RabbitMQ — healthy; worker и dispatcher работают. Войдите в Reporting, откройте Dogtags, обработайте синтетический CSV и скачайте результат. Проверьте переходы во все остальные разделы. Полный порядок приёмки: [verification.md](verification.md).

## Обновления и сохранение данных

Перед обновлением сделайте согласованный backup базы и файлов Dogtags. Если на сервере уже есть его данные, сохраните прежние пароли, имена volumes и node identity RabbitMQ. При смене Compose-проекта сопоставьте существующие volumes через серверный override с `external: true`: `dogtags-postgres-data`, `dogtags-rabbitmq-data`, `dogtags-artifacts`, `dogtags-scratch`. Прежние API/worker/dispatcher необходимо остановить до подключения тех же данных новыми контейнерами.

На новой установке Compose создаёт отдельные volumes текущего проекта. Не выполняйте `down -v` для рабочих данных. Миграции `dogtags-init` применяются вперёд.

Известные ограничения, которые нужно учитывать перед выпуском: исходные domain-тесты Dogtags содержат ранее обнаруженные ошибки; общий TypeScript-check Reporting также не полностью проходит. Они не исправлялись этой интеграцией. Фактическую готовность `t2product.ru` подтверждает серверная приёмка, а не наличие кода в GitHub.
