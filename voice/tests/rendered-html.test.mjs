import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html", host: "localhost" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the authorization page", async () => {
  const response = await render("/login");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(
    html,
    /<title>Агент мобильной карусели — редактор опорных номеров и АОН<\/title>/i,
  );
  assert.match(html, /Войдите в приложение/);
  assert.match(html, /Почта является логином/);
  assert.match(html, /Агент мобильной карусели/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("protects the master page before client authorization", async () => {
  const response = await render("/master");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Проверяем авторизацию/);
  assert.doesNotMatch(html, /Загрузить файл для merge/);
});

test("removes the disposable starter and keeps product metadata", async () => {
  const [page, masterPage, layout, authProvider, accountPage, css] =
    await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/master/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/auth-provider.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/account/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(authProvider, /NEXT_PUBLIC_API_URL/);
  assert.match(authProvider, /Authorization/);
  assert.match(layout, /AuthProvider/);
  assert.match(accountPage, /Создать пользователя/);
  assert.match(accountPage, /Разрешить доступ к мастер-файлу/);
  assert.match(page, /X-Session-ID/);
  assert.match(page, /\/api\/jobs\/convert/);
  assert.match(page, /deleteANumbers/);
  assert.match(page, /deleteBCommands/);
  assert.match(page, /Параметры импорта/);
  assert.match(page, /REQUEST_TUTORIAL_STEPS/);
  assert.match(page, /carousel-request-tutorial:/);
  assert.match(page, /Помощник по обучению/);
  assert.match(page, /Обработка заявки на добавление номеров/);
  assert.match(page, /Выйти из обучения/);
  assert.match(page, /Продолжить обучение по обработке заявки/);
  assert.match(page, /Ожидаю загрузки файла/);
  assert.match(page, /request-tutorial-progress/);
  assert.match(page, /persistTutorial\("dismissed"/);
  assert.match(page, /persistTutorial\("completed",\s*"complete"\)/);
  assert.match(page, /data-tour="raw-variant"/);
  assert.match(page, /data-tour="file-dropzone"/);
  assert.match(page, /data-tour="import-parameters"/);
  assert.match(page, /confirm-import/);
  assert.match(page, /data-tour="import-confirm"/);
  assert.match(page, /Нажмите выделенную кнопку «Подтвердить колонки»/);
  assert.match(page, /data-tour="connections-editor"/);
  assert.match(page, /connection-search/);
  assert.match(page, /data-tour="mapping-search"/);
  assert.match(page, /Например, опорный номер/);
  assert.match(page, /single-pani-kind/);
  assert.match(page, /PANI фактически является ID/);
  assert.match(page, /общее количество знаков стало равно 11/);
  assert.match(page, /data-tour="bulk-parameter-kind"/);
  assert.match(page, /data-tour="bulk-parameter-value"/);
  assert.match(page, /data-tour="bulk-parameter-apply"/);
  assert.match(page, /data-tour="tutorial-add-aon"/);
  assert.match(page, /data-tour="tutorial-added-aon"/);
  assert.match(page, /AonAdditionTextarea/);
  assert.match(page, /HighlightedInvalidNumbers/);
  assert.match(page, /Красным выделены АОН, которые начинаются не с 7/);
  assert.match(page, /Оранжевым выделены АОН с длиной не 11 символов/);
  assert.match(page, /mappingSearchInputRef\.current\?\.focus/);
  assert.match(page, /aNumber !== tutorialPrimaryANumber/);
  assert.match(page, /mapping-expand-action/);
  assert.match(page, /remove-added-aon/);
  assert.match(page, /data-tour="bulk-select-all"/);
  assert.match(page, /data-tour="bulk-delete-selected"/);
  assert.match(page, /restore-all-a/);
  assert.match(page, /bulk-pani-apply/);
  assert.match(page, /data-tour="mapping-filter"/);
  assert.match(page, /data-tour="mapping-filter-options"/);
  assert.match(page, /data-tour="bulk-delete-b"/);
  assert.match(page, /data-tour="bulk-delete-a"/);
  assert.match(page, /data-tour="batch-add"/);
  assert.match(page, /data-tour="preview"/);
  assert.match(page, /data-tour="csv-settings"/);
  assert.match(page, /data-tour="generate"/);
  assert.match(page, /data-tour="download-result"/);
  assert.match(page, /data-tour="send-to-master"/);
  assert.match(page, /Сначала нажмите «Скачать CSV»/);
  assert.match(page, /&tutorial=master/);
  assert.doesNotMatch(page, /Скачать отчёт/);
  assert.match(page, /Сформировать новый CSV/);
  assert.match(page, /\/api\/uploads\/\$\{target\.id\}\/mappings/);
  assert.match(page, /Отметить все АОН на удаление/);
  assert.match(page, /Снять выделение АОН на удаление/);
  assert.match(page, /Отметить все опорные номера/);
  assert.match(page, /toggleAllMappingChoices/);
  assert.match(page, /limit:\s*500/);
  assert.match(page, /while \(offset < total\)/);
  assert.match(page, /Выбираем весь файл…/);
  assert.doesNotMatch(page, /Очистить выбор/);
  assert.doesNotMatch(page, /Настроить формат/);
  assert.match(page, /Удалить выбранные опорные номера/);
  assert.match(page, /Применить параметр/);
  assert.match(page, /Выберите параметр опорного номера/);
  assert.match(
    page,
    /bulk-a-controls[\s\S]*Отметить все опорные номера[\s\S]*Удалить выбранные опорные номера/,
  );
  assert.match(page, /Пакетное удаление АОН/);
  assert.match(page, /Пакетное удаление опорных номеров/);
  assert.match(page, /Пакетное добавление опорных номеров и АОН/);
  assert.match(page, /Параметр для добавляемых номеров/);
  assert.doesNotMatch(page, /Добавить опорный номер и АОН вручную/);
  assert.doesNotMatch(page, /onClick=\{addManualMapping\}/);
  assert.doesNotMatch(page, /setNewMappingA|setNewMappingBText/);
  assert.match(page, /rawBNumbers\.length\s*\?\s*rawBNumbers\s*:\s*\[aNumber\]/);
  assert.match(page, /finalPreviewRows/);
  assert.match(page, /removeManualB/);
  assert.match(page, /sourceHasOnlyA/);
  assert.match(page, /previewRows:\s*null/);
  assert.match(page, /const visibleSourcePreviewRows = previewRows/);
  assert.match(page, /const visibleFinalPreviewRows = finalPreviewRows/);
  assert.doesNotMatch(page, /sourcePreviewExpanded|finalPreviewExpanded/);
  assert.doesNotMatch(page, /Показать все \$\{previewRows\.length\}/);
  assert.match(page, /offset,[\s\S]*limit:\s*200/);
  assert.doesNotMatch(page, /while\s*\(nextOffset\s*<\s*total\)/);
  assert.match(page, /renameANumbers/);
  assert.match(page, /Исправить опорный номер/);
  assert.match(page, /Сохранить исправление/);
  assert.match(page, /Добавить АОН/);
  assert.match(page, /addBToMapping/);
  assert.match(
    page,
    /mapping-editor-tools[\s\S]*Добавить АОН к опорному номеру[\s\S]*Параметр опорного номера[\s\S]*className="b-number-grid"/,
  );
  assert.match(page, /У этого опорного номера пока нет АОН/);
  assert.match(page, /downloadButtonRef\.current\?\.scrollIntoView/);
  assert.match(page, /ref=\{downloadButtonRef\}/);
  assert.match(page, /Вариант 1/);
  assert.match(page, /Обработка заявки на добавление номеров/);
  assert.match(page, /Вариант 2/);
  assert.match(page, /Редактировать готовый CSV файл/);
  assert.match(page, /Загрузите файл/);
  assert.match(page, /Перетащите файл в эту область/);
  assert.match(page, /Первый столбец выбран автоматически/);
  assert.match(page, /Одна колонка с готовыми строками/);
  assert.match(page, /deleteBNumbers/);
  assert.match(page, /bulkDeleteBNumbers/);
  assert.match(page, /mappingSearchScore/);
  assert.match(page, /searchMatchedANumbers/);
  assert.match(page, /normalizedMappingQuery\s*&&\s*searchMatch/);
  assert.match(page, /mappingListRef\.current\?\.scrollTo/);
  assert.match(page, /HighlightedNumber/);
  assert.match(page, /loadMappingOptions\(upload,\s*""\)/);
  assert.match(page, /Совпадения подняты вверх и раскрыты/);
  assert.match(page, /if \(exact\.length\) return exact/);
  assert.match(page, /Найти опорный номер, PANI или АОН/);
  assert.doesNotMatch(page, /PANI, АОН или параметр/);
  assert.doesNotMatch(page, /parameter\.includes\(query\)/);
  assert.match(page, /Фильтр параметров/);
  assert.match(page, /Параметры этого файла/);
  assert.match(page, /mappingParameterOptions/);
  assert.match(page, /effectiveMappingParameterGroups/);
  assert.match(page, /selectedMappingParameterGroups/);
  assert.match(
    page,
    /mappingFormats\.map[\s\S]*effectiveMappingParameterGroups[\s\S]*counts\.set/,
  );
  assert.doesNotMatch(page, /mappingParameterSort|Сортировка/);
  assert.match(page, /каждый опорный[\s\S]*сохраняет свой параметр/);
  assert.match(page, /duplicate-sticky-navigator/);
  assert.match(page, /Показать следующий дубликат/);
  assert.match(page, /activeDuplicateTargetRef\.current\?\.scrollIntoView/);
  assert.match(page, /is-active-duplicate-a/);
  assert.match(page, /is-active-duplicate-b/);
  assert.match(page, /query:\s*targetNumber/);
  assert.match(masterPage, /Параметр строки/);
  assert.match(masterPage, /<th>Параметр<\/th>/);
  assert.match(masterPage, /type="date"/);
  assert.match(masterPage, /visibleBNumbers/);
  assert.match(masterPage, /master-search-highlight/);
  assert.match(masterPage, /Показать дубликаты/);
  assert.match(masterPage, /Общие параметры/);
  assert.match(masterPage, /parameterOptions/);
  assert.match(masterPage, /Все параметры с номером PANI/);
  assert.match(masterPage, /PANI \+ код региона/);
  assert.match(masterPage, /pani-region/);
  assert.match(masterPage, /pani_region/);
  assert.match(masterPage, /\$\{pani\}& D\$\{region\}\$&null&/);
  assert.match(masterPage, /Расширенный поиск/);
  assert.match(masterPage, /Укажите опорные номера или АОН/);
  assert.match(masterPage, /parseNumbers\(query\)/);
  assert.match(masterPage, /aonSearchMatchesByRecord/);
  assert.match(masterPage, /Опорный номер должен начинаться с 7/);
  assert.match(masterPage, /Имеются АОН, которые начинаются не с 7/);
  assert.match(masterPage, /Исправить номера/);
  assert.match(masterPage, /openInvalidRecordForEdit/);
  assert.match(masterPage, /Мастер-файл автоматически занят вами/);
  assert.match(
    masterPage,
    /!masterEditable &&\s*!recordHasInvalidNumberStart\(record\)/,
  );
  assert.match(masterPage, /Это только\s+подсветка; сохранение разрешено/);
  assert.match(masterPage, /highlightInvalidNumbers/);
  assert.match(masterPage, /showEditorBOverlay/);
  assert.match(masterPage, /importInvalidStartBNumbers/);
  assert.match(masterPage, /importInvalidLengthBNumbers/);
  assert.match(masterPage, /Все эти предупреждения не блокируют/);
  assert.doesNotMatch(
    masterPage,
    /disabled=\{[\s\S]{0,220}hasInvalidNumberStart\(importEditANumber\)/,
  );
  assert.doesNotMatch(masterPage, /Слияние заблокировано: опорные номера/);
  assert.doesNotMatch(masterPage, /blockingMergeNumberStartErrors/);
  assert.doesNotMatch(masterPage, /mergeAonStartWarnings/);
  assert.match(masterPage, /mergeNumberStartWarnings/);
  assert.match(masterPage, /Это предупреждение не блокирует слияние/);
  assert.match(masterPage, /item\.kind === "a"/);
  assert.doesNotMatch(masterPage, /Найти по A, АОН, параметру/);
  assert.match(masterPage, /selectedRegions/);
  assert.match(masterPage, /Коды регионов 1–84/);
  assert.match(masterPage, /list="master-region-codes"/);
  assert.match(masterPage, /Выберите или введите код региона/);
  assert.match(masterPage, /Если оставить пустым, в АОН будет записан опорный номер/);
  assert.match(masterPage, /masterVersion/);
  assert.match(masterPage, /master-inline-editor-row/);
  assert.match(masterPage, /aonSearchMatch/);
  assert.match(masterPage, /renderAonSearchReveal/);
  assert.match(masterPage, /HighlightedTextareaValue/);
  assert.match(masterPage, /master-highlighted-textarea/);
  assert.match(masterPage, /<span>АОН<\/span>/);
  assert.doesNotMatch(masterPage, /АОН — необязательно/);
  assert.match(masterPage, /setShowEditor\(false\)/);
  assert.match(masterPage, /Занять мастер-файл/);
  assert.match(masterPage, /Освободить мастер-файл/);
  assert.match(masterPage, /releaseMasterForNavigation/);
  assert.match(masterPage, /Уведомить пользователя/);
  assert.match(masterPage, /Другой пользователь пытается загрузить файл/);
  assert.match(masterPage, /\/api\/master\/lock\/notify/);
  assert.match(masterPage, /Мастер-файл временно недоступен/);
  assert.match(masterPage, /masterLock\.owner\.email/);
  assert.match(masterPage, /disabled=\{!masterEditable\}/);
  assert.match(masterPage, /carousel-master-draft:/);
  assert.match(masterPage, /Продолжить с места остановки/);
  assert.match(masterPage, /Продолжить работу/);
  assert.match(masterPage, /Отказаться/);
  assert.match(masterPage, /readMasterDraft/);
  assert.match(masterPage, /parsed\.version !== 3/);
  assert.match(masterPage, /Работа с мастер-файлом/);
  assert.match(masterPage, /MASTER_TUTORIAL_STEPS/);
  assert.match(masterPage, /Очистить журнал и обнулить версию/);
  assert.match(masterPage, /Комментарий к опорному номеру/);
  assert.match(masterPage, /master-record-comment/);
  assert.match(css, /forced-colors:\s*active/);
  assert.match(css, /max-height:\s*min\(580px,\s*70dvh\)/);
  assert.match(masterPage, /Добро пожаловать в мастер-файл/);
  assert.match(masterPage, /Обучение мастер-файлу завершено/);
  assert.match(masterPage, /data-tour="master-lock"/);
  assert.match(masterPage, /data-tour="master-lock-panel"/);
  assert.match(masterPage, /data-tour="master-merge-review"/);
  assert.match(masterPage, /data-tour="master-advanced-search"/);
  assert.match(masterPage, /data-tour="master-filter-toggle"/);
  assert.match(masterPage, /data-tour="master-add-row"/);
  assert.match(masterPage, /data-tour="master-bulk-delete-a"/);
  assert.match(masterPage, /data-tour="master-bulk-delete-b"/);
  assert.match(masterPage, /data-tour="master-scoped-delete"/);
  assert.match(masterPage, /data-tour="master-tabs"/);
  assert.match(masterPage, /data-tour="master-history-dates"/);
  assert.match(masterPage, /goToPreviousMasterTutorialStep/);
  assert.match(masterPage, /Действие выполнено\. Проверьте результат/);
  assert.match(masterPage, /master-replace-all/);
  assert.match(masterPage, /Применить версию из CSV ко всем конфликтам/);
  assert.match(masterPage, /user\?\.role === "superuser"/);
  assert.match(masterPage, /Очистить мастер-файл/);
  assert.match(masterPage, /Вся база номеров будет удалена/);
  assert.match(masterPage, /Подтвердить удаление/);
  assert.match(masterPage, /role="alertdialog"/);
  assert.match(masterPage, /method: "DELETE"/);
  assert.match(css, /\.master-clear-dialog/);
  assert.match(page, /PANI должен состоять ровно из 11 цифр/);
  assert.match(page, /PANI \+ код региона/);
  assert.match(page, /pani-region/);
  assert.match(page, /\$\{pani\}& D\$\{region\}\$&null&/);
  assert.match(page, /Если связка опустеет, она будет удалена целиком/);
  assert.match(page, /numberStartViolations/);
  assert.doesNotMatch(page, /blockingANumberStartViolations/);
  assert.match(page, /aNumberStartWarnings/);
  assert.match(page, /aonNumberStartWarnings/);
  assert.match(page, /Опорный номер должен начинаться с 7/);
  assert.match(page, /Подсвечено АОН не с 7.*Формирование разрешено/);
  assert.match(page, /paniInputValue/);
  assert.match(masterPage, /Предложение на слияние/);
  assert.match(masterPage, /Подтвердить слияние/);
  assert.match(
    masterPage,
    /onClick=\{\(\) => void mergeImport\(\)\}[\s\S]{0,180}disabled=\{\s*merging \|\|\s*!masterEditable\s*\}/,
  );
  assert.match(
    page,
    /onClick=\{\(\) => void startJob\(\)\}[\s\S]{0,220}disabled=\{\s*jobStarting \|\|\s*inspecting \|\|\s*!mappingConfirmed\s*\}/,
  );
  assert.match(masterPage, /Показать новые строки/);
  assert.match(masterPage, /limit:\s*"200"/);
  assert.match(masterPage, /Загрузить следующие 200/);
  assert.match(masterPage, /conflict-scroll-window/);
  assert.match(masterPage, /\/duplicates\?\$\{parameters\.toString\(\)\}/);
  assert.match(masterPage, /master-scroll-window/);
  assert.match(masterPage, /loadRecords\(records\.length\)/);
  assert.match(masterPage, /loadHistory\(history\.length\)/);
  assert.match(masterPage, /Пакетное удаление опорных номеров/);
  assert.match(masterPage, /Пакетное удаление АОН/);
  assert.match(masterPage, /\/api\/master\/records\/batch-delete-a/);
  assert.match(masterPage, /\/api\/master\/records\/batch-delete-b/);
  assert.match(masterPage, /\/api\/master\/records\/batch-delete-b-scoped/);
  assert.match(masterPage, /Удаление АОН у выбранных опорных номеров/);
  assert.match(masterPage, /batchPanel === "scoped-b"/);
  assert.match(masterPage, /toggleScopedANumber/);
  assert.match(masterPage, /Выбрать опорный номер \$\{record\.aNumber\} для удаления АОН/);
  assert.match(masterPage, /Чекбоксы в текущей базе и этот список синхронизированы/);
  assert.match(masterPage, /notLinkedBNumbers/);
  assert.match(masterPage, /не были привязаны ни к одному из указанных опорных номеров/);
  assert.match(masterPage, /invalidOnly/);
  assert.match(masterPage, /Показать некорректные номера/);
  assert.match(masterPage, /hasInvalidNumberLength/);
  assert.match(masterPage, /Длина опорного номера не 11 символов/);
  assert.match(masterPage, /Имеются АОН с длиной не 11 символов/);
  assert.match(masterPage, /record-aon-summary/);
  assert.match(masterPage, /HistoryAonDetails/);
  assert.match(masterPage, /Удалённые АОН/);
  assert.doesNotMatch(masterPage, /Фильтр и сортировка/);
  assert.doesNotMatch(masterPage, /По параметру: А → Я/);
  assert.match(masterPage, /formattedImportLine/);
  assert.match(masterPage, /Сохранить строку/);
  assert.match(masterPage, /\/items\/\$\{item\.id\}/);
  assert.match(css, /\.new-record-preview-list/);
  assert.match(css, /\.new-record-editor/);
  assert.match(page, /Лишние значения скрыты/);
  assert.match(page, /mapping\.linkedANumber/);
  assert.match(page, /mappingFormatFromSource/);
  assert.match(page, /Найти опорный номер, PANI или АОН/);
  assert.match(page, /<option value="default">По умолчанию<\/option>/);
  assert.match(page, /Введите свой параметр/);
  assert.doesNotMatch(
    page,
    /PANI — ID из номера лицевого счёта и дополнительных цифр/,
  );
  assert.match(css, /\.mapping-item\.is-search-result/);
  assert.match(css, /\.mapping-linked-a-meta/);
  assert.match(css, /\.b-number-option\.is-search-match/);
  assert.match(css, /\.number-search-highlight/);
  assert.match(css, /\.duplicate-sticky-navigator\s*\{/);
  assert.match(css, /\.mapping-item\.is-active-duplicate-a/);
  assert.match(css, /\.b-number-option\.is-active-duplicate-b/);
  assert.match(page, /regionCode/);
  assert.match(page, /Выберите опорный номер и задайте формат его связки/);
  assert.match(page, /Опорный с PANI/);
  assert.match(page, /Исходный вариант/);
  assert.match(page, /Итоговый вариант/);
  assert.match(page, /Связка не попадёт в итоговый CSV/);
  assert.doesNotMatch(page, /side-panel|Рабочая сессия/);
  assert.match(page, /section-collapse-button/);
  assert.match(page, /toggleSection\("bulkDeleteB"\)/);
  assert.match(page, /toggleSection\("bulkDeleteA"\)/);
  assert.match(page, /toggleSection\("batchAdd"\)/);
  assert.match(
    page,
    /function collapsedSectionState[\s\S]*bulkDeleteB:\s*openSection !== "bulkDeleteB"[\s\S]*bulkDeleteA:\s*openSection !== "bulkDeleteA"[\s\S]*batchAdd:\s*openSection !== "batchAdd"/,
  );
  assert.match(page, /useState<[\s\S]*collapsedSectionState\("upload"\)/);
  assert.match(
    page,
    /collapsedSectionState\(formatted \? "editor" : "import"\)/,
  );
  assert.match(
    page,
    /setCollapsedSections\([\s\S]*collapsedSectionState\("editor"\)/,
  );
  assert.match(
    page,
    /section-index-label">[\s\S]*Импорт[\s\S]*id="settings-title">Параметры импорта[\s\S]*section-index">02[\s\S]*id="connections-editor-title">[\s\S]*Редактирование связок/,
  );
  assert.doesNotMatch(page, /Найдите и отредактируйте любую связку/);
  assert.doesNotMatch(
    page,
    /УДАЛЕНИЕ И ИЗМЕНЕНИЕ СУЩЕСТВУЮЩИХ СВЯЗОК/,
  );
  assert.match(
    page,
    /section-index">03[\s\S]*Пакетное удаление АОН[\s\S]*section-index">04[\s\S]*Пакетное удаление опорных номеров[\s\S]*section-index">05[\s\S]*Пакетное добавление опорных номеров и АОН[\s\S]*section-index">06[\s\S]*Предпросмотр и проверка/,
  );
  assert.match(
    page,
    /id="preview-title"[\s\S]*className="card csv-settings-card"[\s\S]*id="csv-title"/,
  );
  assert.doesNotMatch(page, /editor-csv-settings/);
  assert.match(page, /const aSelected = aNumbers\.includes/);
  assert.match(page, /chosenANumbers\.every\(\(item\) =>\s+aNumbers\.includes/);
  assert.match(page, /mappingFormats/);
  assert.match(page, /mappingFormatPreview/);
  assert.match(page, /vladimir\.sobolev@t2\.ru/);
  assert.match(page, /Продолжить редактирование/);
  assert.match(page, /Подгрузить в мастер файл/);
  assert.match(css, /#ff3495/i);
  assert.match(css, /\.final-preview-row\.is-removed/);
  assert.doesNotMatch(css, /\.workspace\.is-sidebar-collapsed/);
  assert.match(css, /\.batch-add-layout/);
  assert.match(css, /\.operation-card/);
  assert.match(css, /\.collapsible-card\.is-collapsed/);
  assert.match(
    css,
    /\.collapsible-card\.is-collapsed > \.section-heading p\s*\{\s*display:\s*none/,
  );
  assert.match(css, /grid-template-areas:[\s\S]*"kind value value apply"/);
  assert.match(
    css,
    /\.mapping-list\s*\{[\s\S]*contain:\s*layout paint[\s\S]*overflow-y:\s*auto/,
  );
  assert.match(
    css,
    /\.preview-scroll-window\s*\{[\s\S]*contain:\s*layout paint[\s\S]*overflow:\s*auto/,
  );
  assert.match(css, /\.master-hero-actions\s*\{[\s\S]*grid-template-columns:\s*repeat\(2/);
  assert.match(css, /\.preview-scroll-window\s*\{[\s\S]*max-height:\s*min\(580px,\s*70dvh\)[\s\S]*overflow:\s*auto/);
  assert.match(css, /\.request-tutorial-backdrop/);
  assert.match(
    css,
    /\.request-tutorial-backdrop\s*\{[\s\S]*pointer-events:\s*none/,
  );
  assert.match(css, /\.request-tutorial-focus/);
  assert.match(css, /\.request-tutorial-context/);
  assert.match(css, /\.request-tutorial-done/);
  assert.match(css, /\.request-tutorial-coach/);
  assert.match(css, /\.request-tutorial-launcher/);
  assert.match(css, /\.master-replace-all/);
  assert.match(css, /\.master-scroll-window\s*\{[\s\S]*max-height:\s*650px[\s\S]*overflow:\s*auto/);
  assert.match(css, /\.conflict-scroll-window\s*\{[\s\S]*max-height:\s*520px[\s\S]*overflow:\s*auto/);
  assert.match(css, /\.master-batch-actions/);
  assert.match(css, /\.master-batch-toggle/);
  assert.match(css, /\.mapping-expand-action/);
  assert.match(css, /\.master-record-selection/);
  assert.match(css, /\.record-number-warning\.is-aon-warning/);
  assert.match(css, /\.master-selected-a-list/);
  assert.match(css, /\.master-invalid-aon-scroll\s*\{[\s\S]*max-height:\s*230px[\s\S]*overflow:\s*auto/);
  assert.match(css, /\.history-aon-scroll\s*\{[\s\S]*max-height:\s*240px[\s\S]*overflow:\s*auto/);
  assert.match(css, /\.combined-parameter-fields/);
  assert.match(css, /\.master-search-shell/);
  assert.match(css, /\.record-number-warning\.is-blocking-start/);
  assert.match(css, /\.merge-blocking-warning/);
  assert.match(css, /\.master-invalid-reveal-actions/);
  assert.match(
    css,
    /\.master-highlighted-textarea mark\.is-invalid-number-start/,
  );
  assert.match(
    css,
    /\.master-highlighted-textarea mark\.is-invalid-number/,
  );
  assert.match(
    css,
    /\.master-highlighted-textarea pre\s*\{[\s\S]*z-index:\s*0/,
  );
  assert.match(page, /tutorialBackNavigationRef/);
  assert.match(page, /REQUEST_TUTORIAL_MANUAL_CONFIRMATION_STEPS/);
  assert.match(page, /Действие выполнено\. Проверьте результат в списке/);
  assert.match(page, /className="table-wrap preview-scroll-window"/);
  assert.match(page, /className="final-preview-list preview-scroll-window"/);
  assert.match(layout, /lang="ru"/);
  assert.match(layout, /\/og-delete-b\.png/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);

  await assert.rejects(
    access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)),
  );
  await assert.rejects(
    access(new URL("../app/_sites-preview/preview.css", import.meta.url)),
  );
});
