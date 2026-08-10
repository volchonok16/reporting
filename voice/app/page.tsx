"use client";

import {
  ChangeEvent,
  DragEvent,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppHeader } from "./app-header";
import { useAuth } from "./auth-provider";

type ImportMode = "auto" | "raw" | "formatted";
type StartVariant = "raw" | "formatted";
type JobStatus =
  | "queued"
  | "inspecting"
  | "validating"
  | "processing"
  | "exporting"
  | "completed"
  | "failed"
  | "cancelled";

type Upload = {
  id: string;
  name: string;
  size: number;
  format: string;
};

type ColumnOption = { index: number; name: string };
type DuplicateFinding = {
  kind: "a" | "b";
  aNumber: string;
  bNumber?: string | null;
  firstSourceRow: number;
  sourceRow: number;
};
type WhitespaceFinding = {
  kind: "a" | "b";
  aNumber: string;
  bNumber?: string | null;
  sourceRow: number;
};
type Inspection = {
  sheets?: unknown[];
  sheet?: string | null;
  mode?: string;
  columns?: unknown[];
  suggestedAColumn?: number | string | null;
  suggestedBColumn?: number | string | null;
  sourceHasOnlyA?: boolean;
  preview?: unknown[];
  stats?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  validation?: Record<string, unknown>;
  statistics?: Record<string, unknown>;
  duplicates?: DuplicateFinding[];
  whitespaceFindings?: WhitespaceFinding[];
  [key: string]: unknown;
};
type MappingOption = {
  aNumber: string;
  bNumbers: string[];
  bTotal?: number;
  bTruncated?: boolean;
  sourcePrefix?: string;
  linkedANumber?: string;
};
type RenameACommand = {
  fromANumber: string;
  toANumber: string;
};
type MappingFormatKind =
  | "default"
  | "linked-a"
  | "region"
  | "pani-region"
  | "custom";
type MappingParameterGroup =
  | "default"
  | "pani"
  | "region"
  | "pani-region"
  | "custom";
type DuplicateDecision = "keep" | "remove" | null;
type PreviewTab = "source" | "final";
type RequestTutorialStepId =
  | "welcome"
  | "select-raw"
  | "upload-file"
  | "import-parameters"
  | "confirm-import"
  | "connection-search"
  | "select-connection"
  | "single-pani-kind"
  | "single-pani-value"
  | "single-pani-apply"
  | "expand-connection"
  | "add-aon"
  | "remove-added-aon"
  | "select-all-a"
  | "delete-all-a"
  | "restore-all-a"
  | "bulk-pani-kind"
  | "bulk-pani-value"
  | "bulk-pani-apply"
  | "parameter-filter"
  | "parameter-filter-options"
  | "bulk-delete-b"
  | "bulk-delete-a"
  | "batch-add"
  | "preview"
  | "csv-settings"
  | "generate"
  | "download-result"
  | "send-to-master"
  | "complete";
type RequestTutorialStatus = "active" | "dismissed" | "completed";
type RequestTutorialStep = {
  id: RequestTutorialStepId;
  title: string;
  description: string;
  action: string;
  target?: string;
};
type StoredRequestTutorial = {
  status: RequestTutorialStatus;
  step: RequestTutorialStepId;
};
type CollapsibleSection =
  | "upload"
  | "import"
  | "editor"
  | "bulkDeleteB"
  | "bulkDeleteA"
  | "batchAdd"
  | "preview";

function collapsedSectionState(
  openSection: CollapsibleSection | null,
): Record<CollapsibleSection, boolean> {
  return {
    upload: openSection !== "upload",
    import: openSection !== "import",
    editor: openSection !== "editor",
    bulkDeleteB: openSection !== "bulkDeleteB",
    bulkDeleteA: openSection !== "bulkDeleteA",
    batchAdd: openSection !== "batchAdd",
    preview: openSection !== "preview",
  };
}

type MappingFormatSelection = MappingOption & {
  kind: MappingFormatKind;
  value: string;
};
type MappingOptionsResponse = {
  items: MappingOption[];
  total: number;
  offset: number;
  limit: number;
  mode?: "raw" | "formatted";
  sheet?: string;
};
type Job = {
  id: string;
  status: JobStatus;
  stage?: string | null;
  progress?: number;
  processedRows?: number;
  totalRows?: number;
  error?: unknown;
  summary?: Record<string, unknown> | null;
};
type CsvSettings = {
  encoding: "utf-8";
  bom: boolean;
  delimiter: string;
  lineEnding: "LF" | "CRLF";
};

const ACCEPTED_EXTENSIONS = [".xlsx", ".xls", ".xlsb", ".csv"];
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const REQUEST_TUTORIAL_STORAGE_VERSION = "v2";
const REQUEST_TUTORIAL_MANUAL_CONFIRMATION_STEPS = new Set<RequestTutorialStepId>([
  "remove-added-aon",
  "select-all-a",
  "delete-all-a",
  "restore-all-a",
]);
const REQUEST_TUTORIAL_STEPS: RequestTutorialStep[] = [
  {
    id: "welcome",
    title: "Добро пожаловать в обработку заявок",
    description:
      "Помощник проведёт вас по созданию новых связок опорных номеров и АОН — от выбора исходного файла до готового CSV.",
    action:
      "Обучение проходит прямо в рабочем интерфейсе. Его можно закрыть и продолжить позже с сохранённого шага.",
  },
  {
    id: "select-raw",
    title: "Выберите тип входящей заявки",
    description:
      "Этот вариант предназначен для сырых файлов: в них может быть одна колонка с опорными номерами или две колонки — с опорными номерами и АОН.",
    action: "Нажмите выделенную карточку, чтобы перейти к загрузке файла.",
    target: '[data-tour="raw-variant"]',
  },
  {
    id: "upload-file",
    title: "Загрузите файл заявки",
    description:
      "Приложение принимает XLSX, XLS, XLSB и CSV размером до 100 МБ, проверяет структуру и предлагает подходящие колонки.",
    action:
      "Перетащите файл в выделенную область или нажмите «Выбрать файл». Следующий шаг откроется после завершения проверки.",
    target: '[data-tour="file-dropzone"]',
  },
  {
    id: "import-parameters",
    title: "Проверьте параметры импорта",
    description:
      "Здесь выбираются лист и колонки с опорными номерами и АОН. Если файл содержит только опорные номера, приложение автоматически продублирует их в АОН.",
    action:
      "Проверьте предложенные лист и колонки. Затем нажмите «Далее» — помощник отдельно покажет кнопку подтверждения.",
    target: '[data-tour="import-parameters"]',
  },
  {
    id: "confirm-import",
    title: "Подтвердите параметры импорта",
    description:
      "Подтверждение фиксирует выбранные колонки перед дальнейшим редактированием и формированием CSV.",
    action: "Нажмите выделенную кнопку «Подтвердить колонки».",
    target: '[data-tour="import-confirm"]',
  },
  {
    id: "connection-search",
    title: "Найдите отдельную связку",
    description:
      "Поиск находит связку по опорному номеру, PANI или любому привязанному АОН и поднимает совпадения в начало списка.",
    action:
      "Введите в выделенное поле какой-нибудь запрос — например, опорный номер из загруженного файла.",
    target: '[data-tour="mapping-search"]',
  },
  {
    id: "select-connection",
    title: "Выберите опорный номер",
    description:
      "Выбранный номер можно изменить отдельно, а позже тот же инструмент позволит применить действие сразу ко всем номерам.",
    action: "Отметьте чекбокс у найденного опорного номера.",
    target: '[data-tour="tutorial-mapping-choice"]',
  },
  {
    id: "single-pani-kind",
    title: "Назначьте номеру параметр PANI",
    description:
      "Параметр выбранного опорного номера задаётся в панели массовых действий, даже если сейчас выбран только один номер.",
    action: "В поле параметра выберите вариант «Опорный с PANI».",
    target: '[data-tour="bulk-parameter-kind"]',
  },
  {
    id: "single-pani-value",
    title: "Введите корректный PANI",
    description:
      "PANI фактически является ID. Возьмите номер лицевого счёта клиента и добавьте к нему столько цифр, чтобы общее количество знаков стало равно 11.",
    action: "Введите в выделенное поле PANI, состоящий ровно из 11 цифр.",
    target: '[data-tour="bulk-parameter-value"]',
  },
  {
    id: "single-pani-apply",
    title: "Примените параметр",
    description:
      "До применения новое значение остаётся только в поле настройки. После применения строка покажет текущий и новый параметры.",
    action: "Нажмите «Применить параметр».",
    target: '[data-tour="bulk-parameter-apply"]',
  },
  {
    id: "expand-connection",
    title: "Раскройте изменённый номер",
    description:
      "Внутри раскрытой связки находятся добавление АОН, параметр опорного номера и отметки АОН на удаление.",
    action: "Нажмите на изменённый опорный номер, чтобы раскрыть его.",
    target: '[data-tour="tutorial-mapping-expand"]',
  },
  {
    id: "add-aon",
    title: "Добавьте АОН",
    description:
      "К одному опорному номеру можно добавить один или несколько АОН. Введите номера по одному в строке или через запятую.",
    action: "Введите новый АОН и нажмите «Добавить АОН».",
    target: '[data-tour="tutorial-add-aon"]',
  },
  {
    id: "remove-added-aon",
    title: "Отметьте АОН на удаление",
    description:
      "Отметка не удаляет номер немедленно. АОН попадёт в список изменений и будет удалён только после формирования итогового CSV.",
    action: "Установите чекбокс у только что добавленного АОН.",
    target: '[data-tour="tutorial-added-aon"]',
  },
  {
    id: "select-all-a",
    title: "Отметьте все опорные номера",
    description:
      "Массовый выбор позволяет выполнить одно действие сразу со всеми показанными опорными номерами.",
    action: "Нажмите «Отметить все опорные номера».",
    target: '[data-tour="bulk-select-all"]',
  },
  {
    id: "delete-all-a",
    title: "Отметьте опорные номера на удаление",
    description:
      "Выбранные опорные номера и их АОН можно целиком исключить из будущего CSV. Сейчас мы только покажем, как работает отметка.",
    action: "Нажмите «Удалить выбранные опорные номера».",
    target: '[data-tour="bulk-delete-selected"]',
  },
  {
    id: "restore-all-a",
    title: "Снимите отметку на удаление",
    description:
      "Отметку можно отменить до формирования файла — исходные данные при этом не изменяются.",
    action: "Нажмите «Отменить удаление выбранных».",
    target: '[data-tour="bulk-delete-selected"]',
  },
  {
    id: "bulk-pani-kind",
    title: "Задайте параметр всем номерам",
    description:
      "Все опорные номера уже выбраны. Теперь один параметр можно применить ко всему выбранному набору.",
    action: "Снова выберите вариант «Опорный с PANI».",
    target: '[data-tour="bulk-parameter-kind"]',
  },
  {
    id: "bulk-pani-value",
    title: "Введите новый PANI для всех номеров",
    description:
      "Как и раньше, PANI является ID: номер лицевого счёта дополняется цифрами до общей длины ровно 11 знаков.",
    action: "Введите новый PANI из 11 цифр.",
    target: '[data-tour="bulk-parameter-value"]',
  },
  {
    id: "bulk-pani-apply",
    title: "Примените PANI ко всем номерам",
    description:
      "Приложение сохранит индивидуальную настройку для каждого выбранного опорного номера.",
    action: "Нажмите «Применить параметр».",
    target: '[data-tour="bulk-parameter-apply"]',
  },
  {
    id: "parameter-filter",
    title: "Откройте фильтр параметров",
    description:
      "Фильтр формируется по текущему состоянию загруженного файла и учитывает изменения, сделанные в редакторе.",
    action: "Нажмите «Фильтр параметров».",
    target: '[data-tour="mapping-filter"]',
  },
  {
    id: "parameter-filter-options",
    title: "Доступные параметры файла",
    description:
      "Здесь отображаются только фактически заведённые параметры. Если после изменений у опорных номеров будут разные параметры, фильтр покажет все варианты и позволит оставить на экране только нужные.",
    action: "Посмотрите доступные варианты и нажмите «Далее».",
    target: '[data-tour="mapping-filter-options"]',
  },
  {
    id: "bulk-delete-b",
    title: "Пакетное удаление АОН",
    description:
      "Этот блок ищет каждый указанный АОН во всём файле и удаляет все его вхождения. Если связка опустеет, она будет удалена целиком.",
    action:
      "Используйте блок только при необходимости массового удаления. Для продолжения нажмите «Далее».",
    target: '[data-tour="bulk-delete-b"]',
  },
  {
    id: "bulk-delete-a",
    title: "Пакетное удаление опорных номеров",
    description:
      "Здесь можно удалить сразу несколько опорных номеров вместе со всеми привязанными к ним АОН — вручную или списком из файла.",
    action:
      "Проверьте назначение блока и нажмите «Далее». Заполнять его во время обучения необязательно.",
    target: '[data-tour="bulk-delete-a"]',
  },
  {
    id: "batch-add",
    title: "Пакетное добавление связок",
    description:
      "Блок добавляет несколько опорных номеров и АОН за один раз. Для всей партии можно сразу выбрать общий параметр.",
    action:
      "Связки вводятся построчно. Пустой АОН автоматически заменяется соответствующим опорным номером.",
    target: '[data-tour="batch-add"]',
  },
  {
    id: "preview",
    title: "Сравните исходный и итоговый варианты",
    description:
      "Предпросмотр показывает метрики исходного файла и будущие строки CSV. Добавления, изменения и удаления отмечаются визуально.",
    action:
      "Переключитесь между вкладками «Исходный вариант» и «Итоговый вариант», затем нажмите «Далее».",
    target: '[data-tour="preview"]',
  },
  {
    id: "csv-settings",
    title: "Проверьте настройки CSV",
    description:
      "По умолчанию формируется совместимый CSV в UTF-8 без BOM, с переносами CRLF и запятой. Эти параметры можно изменить перед выгрузкой.",
    action:
      "Обычно настройки можно оставить без изменений. Нажмите «Далее», чтобы перейти к финальному действию.",
    target: '[data-tour="csv-settings"]',
  },
  {
    id: "generate",
    title: "Сформируйте новый CSV",
    description:
      "После подтверждения колонок и решения по найденным дубликатам кнопка запускает обработку. Исходный файл при этом не изменяется.",
    action:
      "Нажмите «Сформировать новый CSV». Помощник дождётся окончания обработки и покажет дальнейшие варианты использования файла.",
    target: '[data-tour="generate"]',
  },
  {
    id: "download-result",
    title: "Скачайте и проверьте результат",
    description:
      "Сформированный файл можно скачать на компьютер, открыть в редакторе CSV и проверить итоговые строки перед дальнейшим использованием.",
    action: "Сначала нажмите «Скачать CSV» и посмотрите сформированный файл.",
    target: '[data-tour="download-result"]',
  },
  {
    id: "send-to-master",
    title: "Передайте результат в мастер-файл",
    description:
      "Готовый CSV можно оставить скачанным файлом или сразу передать в мастер-файл для проверки новых строк, изменений и конфликтов перед слиянием.",
    action:
      "Нажмите «Подгрузить в мастер файл». На странице мастер-файла сразу откроется следующее обучение.",
    target: '[data-tour="send-to-master"]',
  },
  {
    id: "complete",
    title: "Обучение завершено",
    description:
      "Теперь вы знаете весь путь обработки заявки на добавление номеров. Помощник останется доступен на этой странице.",
    action:
      "Нажмите «Готово» или запустите обучение заново, если хотите повторить шаги.",
  },
];
const NO_REGION_PREFIX = "null/$ & null/$ & null/$ &";
const DEFAULT_TEMPLATE = {
  regionCode: "",
  firstBMarker: "4:4",
  nextBMarker: "4",
  weight: "1",
};
const EMAIL_RECIPIENT = "vladimir.sobolev@t2.ru";
const STATUS_LABELS: Record<JobStatus, string> = {
  queued: "В очереди",
  inspecting: "Проверка файла",
  validating: "Валидация данных",
  processing: "Обработка связок",
  exporting: "Подготовка CSV",
  completed: "Готово",
  failed: "Ошибка",
  cancelled: "Отменено",
};
const SUMMARY_LABELS: Record<string, string> = {
  inputRows: "Входных строк",
  totalRows: "Входных строк",
  uniqueA: "Уникальных опорных номеров",
  uniqueANumbers: "Уникальных опорных номеров",
  outputRows: "Строк в результате",
  resultRows: "Строк в результате",
  totalB: "АОН",
  bNumbers: "АОН",
  emptyBReplaced: "Пустых АОН заменено",
  replacedEmptyB: "Пустых АОН заменено",
  duplicateBRemoved: "Дубликатов удалено",
  duplicatesRemoved: "Дубликатов удалено",
  duplicateA: "Повторных опорных строк",
  invalidRows: "Некорректных строк",
  skippedRows: "Пропущено строк",
  reportRows: "Строк в отчёте",
  resultSize: "Размер результата",
  requestedA: "Запрошено опорных номеров",
  foundA: "Найдено опорных номеров",
  deletedRows: "Удалено строк",
  notFoundA: "Опорные номера не найдены",
  remainingMappings: "Осталось связок",
  processedA: "Обработано опорных номеров",
  deletedB: "Удалено АОН",
  notFoundB: "АОН не найдено",
  requestedGlobalB: "АОН в пакетном списке",
  deletedGlobalB: "Пакетно удалено АОН",
  notFoundGlobalB: "АОН из списка не найдено",
  globalChangedA: "Опор изменено пакетно",
  globalDeletedEmptyA: "Опустевших связок удалено пакетно",
  deletedEmptyA: "Опустевших связок удалено",
  changedRows: "Изменено строк",
  manualMappings: "Ручных связок",
  manualRequestedB: "Запрошено ручных АОН",
  manualAddedA: "Новых опорных номеров",
  manualAddedB: "Новых АОН",
  manualDuplicateB: "Повторных ручных АОН",
  customFormatsRequested: "Индивидуальных форматов",
  customFormatsApplied: "Форматов применено",
  customFormatsNotFound: "Опора для формата не найдена",
};
const METRIC_DEFINITIONS = [
  {
    label: "Считано строк",
    keys: ["readRows", "totalRows", "rowsRead", "inputRows"],
  },
  {
    label: "Уникальных опор",
    keys: ["uniqueA", "uniqueANumbers"],
  },
  { label: "Всего АОН", keys: ["totalB", "bNumbers"] },
  { label: "Пустых АОН", keys: ["emptyB", "blankB"] },
  {
    label: "Дубликатов опор",
    keys: ["duplicateA", "duplicateANumbers"],
  },
  { label: "Дубликатов АОН", keys: ["duplicateB", "duplicateBNumbers"] },
  { label: "Некорректных", keys: ["invalidValues", "invalidRows", "errors"] },
  { label: "Пропущено строк", keys: ["skippedRows", "emptyRows"] },
  {
    label: "Строк в результате",
    keys: [
      "suggestedResultRows",
      "estimatedOutputRows",
      "outputRows",
      "resultRows",
    ],
  },
];
const SUMMARY_PRIORITY = [
  "resultRows",
  "resultSize",
  "manualAddedA",
  "manualAddedB",
  "deletedRows",
  "deletedB",
  "deletedGlobalB",
  "customFormatsApplied",
  "notFoundA",
  "notFoundB",
  "notFoundGlobalB",
  "invalidRows",
  "reportRows",
  "inputRows",
  "uniqueA",
];

class ApiError extends Error {
  code?: string;
  sourceRow?: number;
  constructor(message: string, code?: string, sourceRow?: number) {
    super(message);
    this.code = code;
    this.sourceRow = sourceRow;
  }
}

function randomSessionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function formatBytes(value: unknown) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} КБ`;
  return `${(value / (1024 * 1024)).toFixed(1)} МБ`;
}
function formatNumber(value: unknown) {
  if (typeof value === "number")
    return new Intl.NumberFormat("ru-RU").format(value);
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric))
      return new Intl.NumberFormat("ru-RU").format(numeric);
    return value;
  }
  return "—";
}
function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.sourceRow)
    return `${error.message} Строка: ${error.sourceRow}.`;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (record.detail) return getErrorMessage(record.detail);
  }
  return "Не удалось выполнить запрос. Попробуйте ещё раз.";
}
function parseApiError(payload: unknown, status: number) {
  let detail = payload;
  if (payload && typeof payload === "object" && "detail" in payload) {
    detail = (payload as Record<string, unknown>).detail;
  }
  if (typeof detail === "string") return new ApiError(detail);
  if (detail && typeof detail === "object") {
    const record = detail as Record<string, unknown>;
    return new ApiError(
      typeof record.message === "string"
        ? record.message
        : `Сервер вернул ошибку ${status}`,
      typeof record.code === "string" ? record.code : undefined,
      typeof record.sourceRow === "number" ? record.sourceRow : undefined,
    );
  }
  return new ApiError(`Сервер вернул ошибку ${status}`);
}
function normalizeColumns(raw: unknown[] | undefined): ColumnOption[] {
  if (!raw) return [];
  return raw.map((item, position) => {
    if (typeof item === "string") return { index: position, name: item };
    if (typeof item === "number")
      return { index: item, name: `Колонка ${item + 1}` };
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const rawIndex = record.index ?? record.id ?? position;
      const index =
        typeof rawIndex === "number" ? rawIndex : Number(rawIndex) || position;
      const name = record.name ?? record.label ?? record.header ?? record.title;
      return {
        index,
        name:
          typeof name === "string" && name ? name : `Колонка ${index + 1}`,
      };
    }
    return { index: position, name: `Колонка ${position + 1}` };
  });
}
function normalizeSheets(raw: unknown[] | undefined): string[] {
  if (!raw) return [];
  return raw
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const value = record.name ?? record.title ?? record.sheet;
        return typeof value === "string" ? value : "";
      }
      return "";
    })
    .filter(Boolean);
}
function suggestedIndex(
  value: unknown,
  columns: ColumnOption[],
  fallback: number,
) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const byName = columns.find((column) => column.name === value);
    if (byName) return byName.index;
    const numeric = Number(value);
    if (Number.isInteger(numeric)) return numeric;
  }
  return columns[fallback]?.index ?? fallback;
}
function previewCells(row: unknown, columns: ColumnOption[]): unknown[] {
  if (Array.isArray(row)) return row;
  if (row && typeof row === "object") {
    const record = row as Record<string, unknown>;
    if (Array.isArray(record.values)) return record.values;
    return columns.map(
      (column) => record[column.name] ?? record[String(column.index)] ?? "",
    );
  }
  return [row];
}
function previewSourceRow(row: unknown, fallback: number) {
  if (row && typeof row === "object") {
    const sourceRow = (row as Record<string, unknown>).sourceRow;
    if (typeof sourceRow === "number" || typeof sourceRow === "string")
      return sourceRow;
  }
  return fallback;
}
function inspectionStats(inspection: Inspection | null) {
  if (!inspection) return {};
  return (
    [
      inspection.statistics,
      inspection.stats,
      inspection.metrics,
      inspection.validation,
    ].find(
      (candidate): candidate is Record<string, unknown> =>
        !!candidate && typeof candidate === "object",
    ) ?? {}
  );
}
function metricValue(stats: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (stats[key] !== undefined && stats[key] !== null) return stats[key];
  }
  return undefined;
}
function parseANumbers(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[\s,;]+/)
        .map((item) => item.trim().replace(/^\+/, ""))
        .filter(Boolean),
    ),
  );
}
function normalizeMappingSearch(value: string) {
  return value.trim().replace(/^\+/, "");
}
function mappingSearchScore(mapping: MappingOption, query: string) {
  if (!query) return Number.POSITIVE_INFINITY;
  if (mapping.aNumber === query) return 0;
  if (mapping.linkedANumber === query) return 1;
  if (mapping.bNumbers.some((number) => number === query)) return 2;
  if (mapping.aNumber.startsWith(query)) return 3;
  if (mapping.linkedANumber?.startsWith(query)) return 4;
  if (mapping.bNumbers.some((number) => number.startsWith(query))) return 5;
  if (mapping.aNumber.includes(query)) return 6;
  if (mapping.linkedANumber?.includes(query)) return 7;
  if (mapping.bNumbers.some((number) => number.includes(query))) return 8;
  return Number.POSITIVE_INFINITY;
}
function HighlightedNumber({
  value,
  query,
}: {
  value: string;
  query: string;
}) {
  if (!query) return <>{value}</>;
  const matchAt = value.indexOf(query);
  if (matchAt < 0) return <>{value}</>;
  return (
    <>
      {value.slice(0, matchAt)}
      <mark className="number-search-highlight">
        {value.slice(matchAt, matchAt + query.length)}
      </mark>
      {value.slice(matchAt + query.length)}
    </>
  );
}

function hasInvalidNumberLength(value: string) {
  return value.trim().replace(/^\+/, "").length !== 11;
}

function hasNumberWhitespace(value: string) {
  return /\s/.test(value);
}

function editableNumberEntries(value: string) {
  return value
    .split(/[;,\r\n]+/)
    .map((raw) => ({ raw, value: raw.trim() }))
    .filter((entry) => entry.value.length > 0);
}

function HighlightedInvalidNumbers({ value }: { value: string }) {
  const entries = value.split(/(\r?\n|[;,])/g);
  return (
    <>
      {entries.map((entry, entryIndex) => {
        if (entry.trim() && hasNumberWhitespace(entry))
          return (
            <mark
              className="is-invalid-number-whitespace"
              key={`${entry}-${entryIndex}`}
            >
              {entry}
            </mark>
          );
        const parts = entry.split(/(\+?[0-9]+)/g);
        return parts.map((part, partIndex) => {
          const isNumber = /^\+?[0-9]+$/.test(part);
          const classes = isNumber
            ? [
                hasInvalidNumberLength(part) ? "is-invalid-number" : "",
                !numberStartsWithSeven(part)
                  ? "is-invalid-number-start"
                  : "",
              ]
                .filter(Boolean)
                .join(" ")
            : "";
          return classes ? (
            <mark
              className={classes}
              key={`${part}-${entryIndex}-${partIndex}`}
            >
              {part}
            </mark>
          ) : (
            <Fragment key={`${part}-${entryIndex}-${partIndex}`}>
              {part}
            </Fragment>
          );
        });
      })}
    </>
  );
}

function AonAdditionTextarea({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLPreElement>(null);
  const entries = editableNumberEntries(value);
  const numbers = entries.map((entry) => entry.value);
  const invalidLength = numbers.filter(hasInvalidNumberLength);
  const invalidStart = numbers.filter((number) => !numberStartsWithSeven(number));
  const invalidWhitespace = entries
    .filter((entry) => hasNumberWhitespace(entry.raw))
    .map((entry) => entry.raw);
  const highlighted =
    invalidLength.length > 0 ||
    invalidStart.length > 0 ||
    invalidWhitespace.length > 0;

  return (
    <>
      <div
        className={[
          "master-highlighted-textarea",
          "request-aon-highlighted-textarea",
          highlighted ? "has-highlight" : "",
          invalidLength.length ? "has-invalid-number" : "",
          invalidStart.length ? "has-invalid-number-start" : "",
          invalidWhitespace.length ? "has-invalid-number-whitespace" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {highlighted && (
          <pre ref={overlayRef} aria-hidden="true">
            <HighlightedInvalidNumbers value={value} />
          </pre>
        )}
        <textarea
          ref={textareaRef}
          className={highlighted ? "has-aon-highlight" : ""}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onScroll={(event) => {
            if (overlayRef.current)
              overlayRef.current.scrollTop = event.currentTarget.scrollTop;
          }}
          placeholder={"79017094611\n79017091445"}
          rows={2}
          disabled={disabled}
          spellCheck={false}
        />
      </div>
      {!!invalidStart.length && (
        <small className="number-start-blocking-warning">
          Красным выделены АОН, которые начинаются не с 7. Это предупреждение:
          добавление и формирование CSV разрешены.
        </small>
      )}
      {!!invalidLength.length && (
        <small className="number-length-warning">
          Оранжевым выделены АОН с длиной не 11 символов: {invalidLength.join(", ")}.
          Это предупреждение не блокирует добавление или формирование CSV.
        </small>
      )}
      {!!invalidWhitespace.length && (
        <small className="number-whitespace-blocking-warning">
          В АОН обнаружены пробелы. Это предупреждение не блокирует добавление
          или формирование CSV.
        </small>
      )}
    </>
  );
}
function prefixForMappingFormat(selection: MappingFormatSelection) {
  const value = selection.value.trim();
  if (selection.kind === "linked-a")
    return `${value.replace(/^\+/, "")}& null/$ & null/$ &`;
  if (selection.kind === "region")
    return `null/$ & null&D${value.replace(/^D/i, "").replace(/\$$/, "")}$&`;
  if (selection.kind === "pani-region") {
    const { pani, region } = paniRegionValue(value);
    return `${pani}& D${region}$&null&`;
  }
  if (selection.kind === "custom") return selection.value;
  return NO_REGION_PREFIX;
}
function mappingFormatFromSource(
  mapping: MappingOption,
): Pick<MappingFormatSelection, "kind" | "value"> {
  const prefix = mapping.sourcePrefix;
  if (!prefix || prefix === NO_REGION_PREFIX)
    return { kind: "default", value: "" };
  const linkedMatch = prefix.match(
    /^(\+?[0-9]+)& null\/\$ & null\/\$ &$/,
  );
  if (linkedMatch)
    return {
      kind: "linked-a",
      value: linkedMatch[1].replace(/^\+/, ""),
    };
  const combinedMatch =
    prefix.match(/^(\+?[0-9]+)& D?([0-9]+)\$&null&$/) ??
    prefix.match(/^(\+?[0-9]+)& null&D?([0-9]+)\$&$/);
  if (combinedMatch)
    return {
      kind: "pani-region",
      value: joinPaniRegionValue(
        combinedMatch[1].replace(/^\+/, ""),
        combinedMatch[2],
      ),
    };
  const regionMatch = prefix.match(/^null\/\$ & null&D?([0-9]+)\$&$/);
  if (regionMatch) return { kind: "region", value: regionMatch[1] };
  return { kind: "custom", value: prefix };
}
function mappingParameterGroup(mapping: MappingOption): MappingParameterGroup {
  const kind = mappingFormatFromSource(mapping).kind;
  return kind === "linked-a" ? "pani" : kind;
}
const MAPPING_PARAMETER_LABELS: Record<MappingParameterGroup, string> = {
  default: "По умолчанию",
  pani: "С PANI",
  region: "С кодом региона",
  "pani-region": "С PANI и кодом региона",
  custom: "С пользовательским параметром",
};
function mappingFormatError(selection: MappingFormatSelection) {
  const value = selection.value.trim();
  if (
    selection.kind === "linked-a" &&
    !/^[0-9]{11}$/.test(value)
  )
    return "PANI должен состоять ровно из 11 цифр.";
  if (
    selection.kind === "region" &&
    (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 84)
  )
    return "Код региона должен быть числом от 1 до 84.";
  if (selection.kind === "pani-region") {
    const { pani, region } = paniRegionValue(value);
    if (!/^[0-9]{11}$/.test(pani))
      return "PANI должен состоять ровно из 11 цифр.";
    if (!/^[0-9]+$/.test(region) || Number(region) < 1 || Number(region) > 84)
      return "Код региона должен быть числом от 1 до 84.";
  }
  if (selection.kind === "custom") {
    const prefix = selection.value;
    const ampersands = prefix.match(/&/g)?.length ?? 0;
    if (
      !prefix ||
      /[\r\n\u0000=;]/.test(prefix) ||
      !prefix.endsWith("&") ||
      ampersands !== 3
    )
      return "Параметр должен содержать четыре поля, три символа «&» и оканчиваться на «&».";
  }
  return "";
}

function paniInputValue(value: string) {
  return value.replace(/\D/g, "").slice(0, 11);
}

function regionNumberInputValue(value: string) {
  return value.replace(/\D/g, "").slice(0, 2);
}

function paniRegionValue(value: string) {
  const [pani = "", region = ""] = value.split("|");
  return { pani, region };
}

function joinPaniRegionValue(pani: string, region: string) {
  return `${pani}|${region}`;
}

function numberStartsWithSeven(value: string) {
  return value.trim().replace(/^\+/, "").startsWith("7");
}

function MappingParameterValueFields({
  kind,
  value,
  onChange,
  className = "field",
  dataTour,
}: {
  kind: MappingFormatKind;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  dataTour?: string;
}) {
  if (kind === "default") return null;
  if (kind === "pani-region") {
    const parts = paniRegionValue(value);
    return (
      <div
        className={`combined-parameter-fields ${className
          .replace(/\bfield\b/g, "")
          .trim()}`}
        data-tour={dataTour}
      >
        <label className="field">
          <span>Номер PANI</span>
          <input
            value={parts.pani}
            onChange={(event) =>
              onChange(
                joinPaniRegionValue(
                  paniInputValue(event.target.value),
                  parts.region,
                ),
              )
            }
            placeholder="79947013851"
            maxLength={11}
            inputMode="numeric"
          />
        </label>
        <label className="field">
          <span>Код региона</span>
          <input
            value={parts.region}
            onChange={(event) =>
              onChange(
                joinPaniRegionValue(
                  parts.pani,
                  regionNumberInputValue(event.target.value),
                ),
              )
            }
            placeholder="29"
            maxLength={2}
            inputMode="numeric"
          />
          <small>Число от 1 до 84.</small>
        </label>
      </div>
    );
  }
  return (
    <label className={className} data-tour={dataTour}>
      <span>
        {kind === "linked-a"
          ? "Номер PANI"
          : kind === "region"
            ? "Код региона"
            : "Введите свой параметр"}
      </span>
      <input
        value={value}
        onChange={(event) =>
          onChange(
            kind === "linked-a"
              ? paniInputValue(event.target.value)
              : kind === "region"
                ? regionNumberInputValue(event.target.value)
              : event.target.value,
          )
        }
        placeholder={
          kind === "linked-a"
            ? "79947013851"
            : kind === "region"
              ? "29"
              : "79947013851& null/$ & null/$ &"
        }
        maxLength={kind === "linked-a" ? 11 : kind === "region" ? 2 : 256}
        inputMode={kind === "linked-a" || kind === "region" ? "numeric" : "text"}
      />
      {kind !== "linked-a" && (
        <small>
          {kind === "custom"
            ? "Введите точное начало строки с тремя «&», включая последний."
            : "Число от 1 до 84. Символы D и $ добавятся автоматически."}
        </small>
      )}
    </label>
  );
}
export default function Home() {
  const { user, authorizedFetch } = useAuth();
  const sessionId = useRef("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const commandInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  const mappingListRef = useRef<HTMLDivElement>(null);
  const mappingSearchInputRef = useRef<HTMLInputElement>(null);
  const activeDuplicateTargetRef = useRef<HTMLElement | null>(null);
  const downloadButtonRef = useRef<HTMLButtonElement>(null);
  const scrolledToResultJobRef = useRef("");
  const pollAbortRef = useRef<AbortController | null>(null);
  const mappingsAbortRef = useRef<AbortController | null>(null);
  const tutorialInitializedForRef = useRef("");
  const tutorialBackNavigationRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [uploading, setUploading] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [startVariant, setStartVariant] = useState<StartVariant | null>(null);
  const [mode, setMode] = useState<ImportMode>("auto");
  const [sheet, setSheet] = useState("");
  const [aColumn, setAColumn] = useState(0);
  const [bColumn, setBColumn] = useState(1);
  const [mappingConfirmed, setMappingConfirmed] = useState(false);
  const [duplicateDecision, setDuplicateDecision] =
    useState<DuplicateDecision>(null);
  const [duplicateCursor, setDuplicateCursor] = useState(0);
  const [activeDuplicate, setActiveDuplicate] = useState<{
    finding: DuplicateFinding;
    index: number;
  } | null>(null);
  const [duplicateNavigating, setDuplicateNavigating] = useState(false);
  const [csv, setCsv] = useState<CsvSettings>({
    encoding: "utf-8",
    bom: false,
    delimiter: ",",
    lineEnding: "CRLF",
  });
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [batchManualText, setBatchManualText] = useState("");
  const [newMappingFormatKind, setNewMappingFormatKind] =
    useState<MappingFormatKind>("default");
  const [newMappingFormatValue, setNewMappingFormatValue] = useState("");
  const [manualAdditions, setManualAdditions] = useState<MappingOption[]>([]);
  const [bAdditionsByA, setBAdditionsByA] = useState<Record<string, string>>(
    {},
  );
  const [mappingFormats, setMappingFormats] = useState<
    MappingFormatSelection[]
  >([]);
  const [renameANumbers, setRenameANumbers] = useState<RenameACommand[]>([]);
  const [aNumberEditValues, setANumberEditValues] = useState<
    Record<string, string>
  >({});
  const [aNumbersText, setANumbersText] = useState("");
  const [bulkDeleteBText, setBulkDeleteBText] = useState("");
  const [mappingOptions, setMappingOptions] = useState<MappingOption[]>([]);
  const [mappingTotal, setMappingTotal] = useState(0);
  const [mappingQuery, setMappingQuery] = useState("");
  const [mappingFilterOpen, setMappingFilterOpen] = useState(false);
  const [selectedMappingParameterGroups, setSelectedMappingParameterGroups] =
    useState<MappingParameterGroup[]>([]);
  const [mappingsLoading, setMappingsLoading] = useState(false);
  const [mappingsError, setMappingsError] = useState("");
  const [selectingAllANumbers, setSelectingAllANumbers] = useState(false);
  const [chosenANumbers, setChosenANumbers] = useState<string[]>([]);
  const [expandedANumbers, setExpandedANumbers] = useState<string[]>([]);
  const [bulkFormatKind, setBulkFormatKind] =
    useState<MappingFormatKind>("default");
  const [bulkFormatValue, setBulkFormatValue] = useState("");
  const [selectedANumbers, setSelectedANumbers] = useState<string[]>([]);
  const [selectedBByA, setSelectedBByA] = useState<Record<string, string[]>>(
    {},
  );
  const [commandUpload, setCommandUpload] = useState<Upload | null>(null);
  const [commandUploading, setCommandUploading] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [jobStarting, setJobStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [resultPreview, setResultPreview] = useState("");
  const [downloading, setDownloading] = useState("");
  const [emailing, setEmailing] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<
    Record<CollapsibleSection, boolean>
  >(collapsedSectionState("upload"));
  const [previewTab, setPreviewTab] = useState<PreviewTab>("final");
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [tutorialStepId, setTutorialStepId] =
    useState<RequestTutorialStepId>("welcome");
  const [tutorialStatus, setTutorialStatus] =
    useState<RequestTutorialStatus>("active");
  const [tutorialDownloadedResult, setTutorialDownloadedResult] =
    useState(false);

  useEffect(() => {
    const storageKey = "carousel-session-id";
    let current = localStorage.getItem(storageKey);
    if (!current) {
      current = randomSessionId();
      localStorage.setItem(storageKey, current);
    }
    sessionId.current = current;
  }, []);
  const getSessionId = useCallback(() => {
    if (!sessionId.current) {
      sessionId.current = randomSessionId();
      if (typeof localStorage !== "undefined")
        localStorage.setItem("carousel-session-id", sessionId.current);
    }
    return sessionId.current;
  }, []);
  const apiFetch = useCallback(
    (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("X-Session-ID", getSessionId());
      if (
        init.body &&
        !(init.body instanceof FormData) &&
        !headers.has("Content-Type")
      )
        headers.set("Content-Type", "application/json");
      return authorizedFetch(path, { ...init, headers });
    },
    [authorizedFetch, getSessionId],
  );

  const columns = useMemo(
    () => normalizeColumns(inspection?.columns),
    [inspection],
  );
  const sheets = useMemo(
    () => normalizeSheets(inspection?.sheets),
    [inspection],
  );
  const stats = useMemo(() => inspectionStats(inspection), [inspection]);
  const duplicateCount =
    Number(metricValue(stats, ["duplicateA", "duplicateANumbers"]) ?? 0) +
    Number(metricValue(stats, ["duplicateB", "duplicateBNumbers"]) ?? 0);
  const duplicateFindings = inspection?.duplicates ?? [];
  const whitespaceFindings = inspection?.whitespaceFindings ?? [];
  const keepDuplicateB = duplicateDecision === "keep";
  const sourceHasOnlyA = inspection?.sourceHasOnlyA === true;
  const bColumnOptions = useMemo(() => {
    if (!sourceHasOnlyA) return columns;
    const syntheticIndex =
      Math.max(-1, ...columns.map((column) => column.index)) + 1;
    return [
      ...columns,
      {
        index: syntheticIndex,
        name: "Нет колонки — АОН будет равен опорному номеру",
      },
    ];
  }, [columns, sourceHasOnlyA]);
  const manualANumbers = useMemo(
    () => parseANumbers(aNumbersText),
    [aNumbersText],
  );
  const bulkDeleteBNumbers = useMemo(
    () => parseANumbers(bulkDeleteBText),
    [bulkDeleteBText],
  );
  const aNumbers = useMemo(
    () => Array.from(new Set([...selectedANumbers, ...manualANumbers])),
    [manualANumbers, selectedANumbers],
  );
  const bCommands = useMemo(
    () =>
      Object.entries(selectedBByA)
        .filter(([, bNumbers]) => bNumbers.length > 0)
        .map(([aNumber, bNumbers]) => ({ aNumber, bNumbers })),
    [selectedBByA],
  );
  const selectedBCount = useMemo(
    () =>
      Object.values(selectedBByA).reduce(
        (total, bNumbers) => total + bNumbers.length,
        0,
      ),
    [selectedBByA],
  );
  const allEditorMappings = useMemo(() => {
    const byA = new Map<string, MappingOption>();
    for (const mapping of manualAdditions) {
      byA.set(mapping.aNumber, {
        ...mapping,
        bNumbers: [...mapping.bNumbers],
        bTotal: mapping.bNumbers.length,
      });
    }
    for (const mapping of mappingOptions) {
      const existing = byA.get(mapping.aNumber);
      if (!existing) {
        byA.set(mapping.aNumber, mapping);
        continue;
      }
      const bNumbers = Array.from(
        new Set([...existing.bNumbers, ...mapping.bNumbers]),
      );
      byA.set(mapping.aNumber, {
        ...mapping,
        bNumbers,
        bTotal: Math.max(mapping.bTotal ?? 0, bNumbers.length),
      });
    }
    return Array.from(byA.values());
  }, [manualAdditions, mappingOptions]);
  const normalizedMappingQuery = useMemo(
    () => normalizeMappingSearch(mappingQuery),
    [mappingQuery],
  );
  const effectiveMappingParameterGroups = useMemo(() => {
    const overrides = new Map(
      mappingFormats.map((selection) => [
        selection.aNumber,
        selection.kind === "linked-a" ? "pani" : selection.kind,
      ]),
    );
    return new Map(
      allEditorMappings.map((mapping) => [
        mapping.aNumber,
        (overrides.get(mapping.aNumber) ??
          mappingParameterGroup(mapping)) as MappingParameterGroup,
      ]),
    );
  }, [allEditorMappings, mappingFormats]);
  const mappingParameterOptions = useMemo(() => {
    const counts = new Map<MappingParameterGroup, number>();
    effectiveMappingParameterGroups.forEach((group) => {
      counts.set(group, (counts.get(group) ?? 0) + 1);
    });
    const order: MappingParameterGroup[] = [
      "default",
      "pani",
      "region",
      "pani-region",
      "custom",
    ];
    return order
      .filter((group) => counts.has(group))
      .map((group) => ({
        id: group,
        label: MAPPING_PARAMETER_LABELS[group],
        count: counts.get(group) ?? 0,
      }));
  }, [effectiveMappingParameterGroups]);
  const parameterFilteredMappings = useMemo(() => {
    return selectedMappingParameterGroups.length
      ? allEditorMappings.filter((mapping) =>
          selectedMappingParameterGroups.includes(
            effectiveMappingParameterGroups.get(mapping.aNumber) ??
              mappingParameterGroup(mapping),
          ),
        )
      : [...allEditorMappings];
  }, [
    allEditorMappings,
    effectiveMappingParameterGroups,
    selectedMappingParameterGroups,
  ]);
  const searchMatchedANumbers = useMemo(
    () => {
      if (!normalizedMappingQuery) return [];
      const scored = parameterFilteredMappings.map((mapping) => ({
        mapping,
        score: mappingSearchScore(mapping, normalizedMappingQuery),
      }));
      const exact = scored.filter(({ score }) => score <= 2);
      return (exact.length
        ? exact
        : scored.filter(({ score }) => Number.isFinite(score))
      ).map(({ mapping }) => mapping.aNumber);
    },
    [normalizedMappingQuery, parameterFilteredMappings],
  );
  const searchMatchedASet = useMemo(
    () => new Set(searchMatchedANumbers),
    [searchMatchedANumbers],
  );
  const editorMappings = useMemo(() => {
    if (!normalizedMappingQuery) return parameterFilteredMappings;
    const scored = parameterFilteredMappings
      .map((mapping, index) => ({
        mapping,
        index,
        score: mappingSearchScore(mapping, normalizedMappingQuery),
      }));
    const exact = scored.filter(({ score }) => score <= 2);
    if (exact.length) return exact.map(({ mapping }) => mapping);
    return scored
      .sort((left, right) => {
        const leftMatches = Number.isFinite(left.score);
        const rightMatches = Number.isFinite(right.score);
        if (leftMatches !== rightMatches) return leftMatches ? -1 : 1;
        if (leftMatches && left.score !== right.score)
          return left.score - right.score;
        return left.index - right.index;
      })
      .map(({ mapping }) => mapping);
  }, [normalizedMappingQuery, parameterFilteredMappings]);
  const hasExactMappingMatches = useMemo(
    () =>
      !!normalizedMappingQuery &&
      parameterFilteredMappings.some(
        (mapping) =>
          mappingSearchScore(mapping, normalizedMappingQuery) <= 2,
      ),
    [normalizedMappingQuery, parameterFilteredMappings],
  );
  const editorMappingTotal = allEditorMappings.length;
  const editorMappingSourceTotal = Math.max(mappingTotal, editorMappingTotal);
  const isRunning =
    !!job && !["completed", "failed", "cancelled"].includes(job.status);
  const isComplete = job?.status === "completed";
  const tutorialPrimaryANumber =
    chosenANumbers[0] ?? editorMappings[0]?.aNumber ?? "";
  const tutorialAddedAon =
    manualAdditions.find(
      (mapping) => mapping.aNumber === tutorialPrimaryANumber,
    )?.bNumbers[0] ?? "";

  useEffect(() => {
    if (
      !isComplete ||
      !job?.id ||
      scrolledToResultJobRef.current === job.id
    )
      return;
    scrolledToResultJobRef.current = job.id;
    window.requestAnimationFrame(() => {
      downloadButtonRef.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "center",
      });
    });
  }, [isComplete, job?.id]);

  const requestInspection = useCallback(
    async (
      target: Upload,
      next: { sheet?: string | null; mode?: ImportMode } = {},
    ) => {
      setInspecting(true);
      setError("");
      setNotice("");
      setMappingConfirmed(false);
      setDuplicateDecision(null);
      setDuplicateCursor(0);
      setActiveDuplicate(null);
      setDuplicateNavigating(false);
      try {
        const response = await apiFetch(`/api/uploads/${target.id}/inspect`, {
          method: "POST",
          body: JSON.stringify({
            sheet: next.sheet === undefined ? null : next.sheet || null,
            mode: next.mode ?? "auto",
            previewRows: null,
          }),
        });
        const payload = (await response.json().catch(() => null)) as
          | Inspection
          | null;
        if (!response.ok) throw parseApiError(payload, response.status);
        if (!payload)
          throw new ApiError("Сервер не вернул результат проверки.");
        const nextColumns = normalizeColumns(payload.columns);
        setInspection(payload);
        setSheet(
          typeof payload.sheet === "string"
            ? payload.sheet
            : next.sheet || normalizeSheets(payload.sheets)[0] || "",
        );
        setAColumn(suggestedIndex(payload.suggestedAColumn, nextColumns, 0));
        setBColumn(
          payload.sourceHasOnlyA === true
            ? Math.max(-1, ...nextColumns.map((column) => column.index)) + 1
            : suggestedIndex(payload.suggestedBColumn, nextColumns, 1),
        );
        const detectedStats = inspectionStats(payload);
        const detectedDuplicates =
          Number(
            metricValue(detectedStats, [
              "duplicateA",
              "duplicateANumbers",
            ]) ?? 0,
          ) +
          Number(
            metricValue(detectedStats, [
              "duplicateB",
              "duplicateBNumbers",
            ]) ?? 0,
          );
        const formatted = (next.mode ?? payload.mode) === "formatted";
        setMappingConfirmed(formatted);
        setDuplicateDecision(detectedDuplicates ? null : "remove");
        setCollapsedSections(
          collapsedSectionState(formatted ? "editor" : "import"),
        );
        setNotice(
          formatted
            ? "Готовый файл распознан. Первый столбец выбран автоматически."
            : "Сырой файл распознан. Проверьте лист и сопоставление колонок.",
        );
      } catch (requestError) {
        setInspection(null);
        setCollapsedSections(collapsedSectionState("upload"));
        setError(getErrorMessage(requestError));
      } finally {
        setInspecting(false);
      }
    },
    [apiFetch],
  );

  const uploadFile = useCallback(
    async (file: File, asCommand = false) => {
      const extension = `.${file.name.split(".").pop()?.toLowerCase()}`;
      if (!ACCEPTED_EXTENSIONS.includes(extension)) {
        setError("Поддерживаются файлы XLSX, XLS, XLSB и CSV.");
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        setError("Файл больше 100 МБ. Выберите файл меньшего размера.");
        return;
      }
      if (asCommand) setCommandUploading(true);
      else {
        setUploading(true);
        setUpload(null);
        setInspection(null);
        setMappingOptions([]);
        setMappingTotal(0);
        setMappingQuery("");
        setMappingFilterOpen(false);
        setSelectedMappingParameterGroups([]);
        setMappingsError("");
        setSelectingAllANumbers(false);
        setChosenANumbers([]);
        setExpandedANumbers([]);
        setBulkFormatKind("default");
        setBulkFormatValue("");
        setSelectedANumbers([]);
        setSelectedBByA({});
        setActiveDuplicate(null);
        setDuplicateCursor(0);
        setDuplicateNavigating(false);
        setBatchManualText("");
        setNewMappingFormatKind("default");
        setNewMappingFormatValue("");
        setManualAdditions([]);
        setBAdditionsByA({});
        setMappingFormats([]);
        setRenameANumbers([]);
        setANumberEditValues({});
        setJob(null);
        setResultPreview("");
        setPreviewTab("final");
      }
      setError("");
      setNotice("");
      try {
        const form = new FormData();
        form.append("file", file);
        const response = await apiFetch("/api/uploads", {
          method: "POST",
          body: form,
        });
        const payload = (await response.json().catch(() => null)) as
          | Upload
          | null;
        if (!response.ok) throw parseApiError(payload, response.status);
        if (!payload?.id)
          throw new ApiError("Сервер не подтвердил загрузку.");
        if (asCommand) {
          setCommandUpload(payload);
          setNotice(
            "Файл команд загружен. Повторяющиеся команды объединены.",
          );
        } else {
          setUpload(payload);
          await requestInspection(payload, {
            mode: startVariant ?? "auto",
          });
        }
      } catch (requestError) {
        setError(getErrorMessage(requestError));
      } finally {
        if (asCommand) setCommandUploading(false);
        else setUploading(false);
      }
    },
    [apiFetch, requestInspection, startVariant],
  );
  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void uploadFile(file);
    event.target.value = "";
  };
  const handleCommandFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void uploadFile(file, true);
    event.target.value = "";
  };
  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void uploadFile(file);
  };
  const loadMappingOptions = useCallback(
    async (
      target: Upload,
      requestedQuery: string,
      offset = 0,
      append = false,
    ) => {
      mappingsAbortRef.current?.abort();
      const controller = new AbortController();
      mappingsAbortRef.current = controller;
      setMappingsLoading(true);
      setMappingsError("");
      try {
        const response = await apiFetch(
          `/api/uploads/${target.id}/mappings`,
          {
            method: "POST",
            signal: controller.signal,
            body: JSON.stringify({
              sheet: sheet || null,
              mode: inspection?.mode ?? "auto",
              aColumn,
              bColumn,
              query: requestedQuery.trim(),
              offset,
              limit: 200,
            }),
          },
        );
        const payload = (await response.json().catch(() => null)) as
          | MappingOptionsResponse
          | null;
        if (!response.ok) throw parseApiError(payload, response.status);
        if (!payload || !Array.isArray(payload.items))
          throw new ApiError("Сервер не вернул список связок.");
        setMappingOptions((current) =>
          append
            ? Array.from(
                new Map(
                  [...current, ...payload.items].map((item) => [
                    item.aNumber,
                    item,
                  ]),
                ).values(),
              )
            : payload.items,
        );
        setMappingTotal(payload.total);
      } catch (requestError) {
        if (
          !(requestError instanceof DOMException) ||
          requestError.name !== "AbortError"
        ) {
          if (!append) {
            setMappingOptions([]);
            setMappingTotal(0);
          }
          setMappingsError(getErrorMessage(requestError));
        }
      } finally {
        if (mappingsAbortRef.current === controller) setMappingsLoading(false);
      }
    },
    [aColumn, apiFetch, bColumn, inspection, sheet],
  );

  const toggleAllMappingChoices = async () => {
    if (!upload || selectingAllANumbers) return;
    setSelectingAllANumbers(true);
    setError("");
    try {
      const byA = new Map<string, MappingOption>();
      const requestedQuery = normalizedMappingQuery;
      let offset = 0;
      let total = 0;
      do {
        const response = await apiFetch(
          `/api/uploads/${upload.id}/mappings`,
          {
            method: "POST",
            body: JSON.stringify({
              sheet: sheet || null,
              mode: inspection?.mode ?? "auto",
              aColumn,
              bColumn,
              query: requestedQuery,
              offset,
              limit: 500,
            }),
          },
        );
        const payload = (await response.json().catch(() => null)) as
          | MappingOptionsResponse
          | null;
        if (!response.ok) throw parseApiError(payload, response.status);
        if (!payload || !Array.isArray(payload.items))
          throw new ApiError("Сервер не вернул полный список связок.");
        payload.items.forEach((item) => byA.set(item.aNumber, item));
        total = payload.total;
        offset += payload.items.length;
        if (!payload.items.length && offset < total)
          throw new ApiError("Не удалось получить все опорные номера файла.");
      } while (offset < total);

      manualAdditions.forEach((item) => {
        if (
          !requestedQuery ||
          Number.isFinite(mappingSearchScore(item, requestedQuery))
        )
          byA.set(item.aNumber, item);
      });
      const formatGroups = new Map(
        mappingFormats.map((item) => [
          item.aNumber,
          item.kind === "linked-a" ? "pani" : item.kind,
        ]),
      );
      const scopedNumbers = Array.from(byA.values())
        .filter(
          (item) =>
            !selectedMappingParameterGroups.length ||
            selectedMappingParameterGroups.includes(
              (formatGroups.get(item.aNumber) ??
                mappingParameterGroup(item)) as MappingParameterGroup,
            ),
        )
        .map((item) => item.aNumber);
      if (!scopedNumbers.length)
        throw new ApiError("В выбранной области нет опорных номеров.");

      const allChosen = scopedNumbers.every((item) =>
        chosenANumbers.includes(item),
      );
      setChosenANumbers((current) =>
        allChosen
          ? current.filter((item) => !scopedNumbers.includes(item))
          : Array.from(new Set([...current, ...scopedNumbers])),
      );
      setNotice(
        allChosen
          ? `Снято выделение со всех опорных номеров: ${scopedNumbers.length}.`
          : `Выбраны все опорные номера: ${scopedNumbers.length}.`,
      );
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setSelectingAllANumbers(false);
    }
  };

  useEffect(() => {
    if (!upload || !inspection) {
      mappingsAbortRef.current?.abort();
      return;
    }
    const timer = window.setTimeout(
      () => void loadMappingOptions(upload, ""),
      0,
    );
    return () => {
      window.clearTimeout(timer);
      mappingsAbortRef.current?.abort();
    };
  }, [inspection, loadMappingOptions, upload]);

  useEffect(() => {
    if (!normalizedMappingQuery) return;
    mappingListRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [normalizedMappingQuery, searchMatchedANumbers.length]);

  useEffect(() => {
    if (!activeDuplicate || collapsedSections.editor) return;
    let nestedFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      nestedFrame = window.requestAnimationFrame(() => {
        activeDuplicateTargetRef.current?.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "auto"
            : "smooth",
          block: "center",
        });
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (nestedFrame) window.cancelAnimationFrame(nestedFrame);
    };
  }, [
    activeDuplicate,
    collapsedSections.editor,
    editorMappings,
    duplicateNavigating,
  ]);

  const updateANumbersForDeletion = (value: string) => {
    const listed = new Set(parseANumbers(value));
    setANumbersText(value);
    setSelectedBByA((current) => {
      const next = { ...current };
      let changed = false;
      listed.forEach((aNumber) => {
        if (next[aNumber]) {
          delete next[aNumber];
          changed = true;
        }
      });
      return changed ? next : current;
    });
  };

  const toggleASelection = (aNumber: string) => {
    const listedForRemoval = manualANumbers.includes(aNumber);
    if (listedForRemoval) {
      setANumbersText((current) =>
        parseANumbers(current)
          .filter((item) => item !== aNumber)
          .join("\n"),
      );
    }
    setSelectedANumbers((current) => {
      const selecting = !current.includes(aNumber) && !listedForRemoval;
      if (selecting) {
        setSelectedBByA((selected) => {
          const next = { ...selected };
          delete next[aNumber];
          return next;
        });
        return [...current, aNumber];
      }
      return current.filter((item) => item !== aNumber);
    });
  };

  const toggleAChoice = (aNumber: string) => {
    setChosenANumbers((current) =>
      current.includes(aNumber)
        ? current.filter((item) => item !== aNumber)
        : [...current, aNumber],
    );
  };

  const toggleAExpanded = (mapping: MappingOption) => {
    const opening = !expandedANumbers.includes(mapping.aNumber);
    setExpandedANumbers((current) =>
      current.includes(mapping.aNumber)
        ? current.filter((item) => item !== mapping.aNumber)
        : [...current, mapping.aNumber],
    );
    if (opening) {
      setMappingFormats((current) =>
        current.some((item) => item.aNumber === mapping.aNumber)
          ? current
          : [
              ...current,
              {
                ...mapping,
                ...mappingFormatFromSource(mapping),
              },
            ],
      );
    }
  };

  const showNextDuplicate = async () => {
    if (!duplicateFindings.length) {
      setNotice(
        "Не удалось получить данные найденных дубликатов. Обновите анализ файла.",
      );
      return;
    }
    const index = duplicateCursor % duplicateFindings.length;
    const duplicate = duplicateFindings[index];
    const targetNumber =
      duplicate.kind === "b" && duplicate.bNumber
        ? duplicate.bNumber
        : duplicate.aNumber;
    activeDuplicateTargetRef.current = null;
    setActiveDuplicate({ finding: duplicate, index });
    setCollapsedSections(collapsedSectionState("editor"));
    setMappingQuery(targetNumber);
    setExpandedANumbers((current) =>
      current.includes(duplicate.aNumber)
        ? current
        : [...current, duplicate.aNumber],
    );
    setDuplicateCursor(
      (current) => (current + 1) % duplicateFindings.length,
    );
    setNotice(
      duplicate.kind === "b"
        ? `Дубликат ${index + 1}/${duplicateFindings.length}: АОН ${duplicate.bNumber} у опорного номера ${duplicate.aNumber}, строки ${duplicate.firstSourceRow} и ${duplicate.sourceRow}.`
        : `Дубликат ${index + 1}/${duplicateFindings.length}: опорный номер ${duplicate.aNumber}, строки ${duplicate.firstSourceRow} и ${duplicate.sourceRow}.`,
    );

    const targetIsLoaded =
      duplicate.kind === "a" ||
      allEditorMappings.some(
        (mapping) =>
          mapping.aNumber === duplicate.aNumber &&
          mapping.bNumbers.includes(duplicate.bNumber ?? ""),
      );
    if (!upload || targetIsLoaded) return;

    setDuplicateNavigating(true);
    try {
      const response = await apiFetch(
        `/api/uploads/${upload.id}/mappings`,
        {
          method: "POST",
          body: JSON.stringify({
            sheet: sheet || null,
            mode: inspection?.mode ?? "auto",
            aColumn,
            bColumn,
            query: targetNumber,
            offset: 0,
            limit: 50,
          }),
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | MappingOptionsResponse
        | null;
      if (!response.ok) throw parseApiError(payload, response.status);
      if (!payload || !Array.isArray(payload.items))
        throw new ApiError("Сервер не вернул найденный дубликат.");
      setMappingOptions((current) => {
        const byA = new Map(
          current.map((mapping) => [
            mapping.aNumber,
            {
              ...mapping,
              bNumbers: [...mapping.bNumbers],
            },
          ]),
        );
        for (const incoming of payload.items) {
          const existing = byA.get(incoming.aNumber);
          byA.set(incoming.aNumber, {
            ...existing,
            ...incoming,
            bNumbers: Array.from(
              new Set([
                ...(existing?.bNumbers ?? []),
                ...incoming.bNumbers,
              ]),
            ),
            bTotal: Math.max(
              existing?.bTotal ?? existing?.bNumbers.length ?? 0,
              incoming.bTotal ?? incoming.bNumbers.length,
            ),
          });
        }
        return Array.from(byA.values());
      });
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setDuplicateNavigating(false);
    }
  };

  const applyBulkADeletion = () => {
    if (!chosenANumbers.length) {
      setError("Сначала выберите хотя бы один опорный номер.");
      return;
    }
    const restore = chosenANumbers.every((aNumber) =>
      aNumbers.includes(aNumber),
    );
    setSelectedANumbers((current) => {
      if (restore)
        return current.filter((item) => !chosenANumbers.includes(item));
      return Array.from(new Set([...current, ...chosenANumbers]));
    });
    if (restore) {
      setANumbersText((current) =>
        parseANumbers(current)
          .filter((item) => !chosenANumbers.includes(item))
          .join("\n"),
      );
    }
    if (!restore) {
      setSelectedBByA((current) => {
        const next = { ...current };
        chosenANumbers.forEach((aNumber) => delete next[aNumber]);
        return next;
      });
    }
    setError("");
    setNotice(
      restore
        ? `Удаление отменено для выбранных опорных номеров: ${chosenANumbers.length}.`
        : `Выбранные опорные номера помечены на удаление: ${chosenANumbers.length}.`,
    );
  };

  const applyBulkAFormat = () => {
    if (!chosenANumbers.length) {
      setError("Сначала выберите хотя бы один опорный номер.");
      return;
    }
    const example: MappingFormatSelection = {
      aNumber: chosenANumbers[0],
      bNumbers: [chosenANumbers[0]],
      kind: bulkFormatKind,
      value: bulkFormatValue,
    };
    const formatError = mappingFormatError(example);
    if (formatError) {
      setError(formatError);
      return;
    }
    setMappingFormats((current) => {
      const byA = new Map(current.map((item) => [item.aNumber, item]));
      chosenANumbers.forEach((aNumber) => {
        const mapping =
          editorMappings.find((item) => item.aNumber === aNumber) ??
          manualAdditions.find((item) => item.aNumber === aNumber);
        const existing = byA.get(aNumber);
        byA.set(aNumber, {
          aNumber,
          bNumbers: mapping?.bNumbers ?? existing?.bNumbers ?? [aNumber],
          bTotal: mapping?.bTotal ?? existing?.bTotal,
          bTruncated: mapping?.bTruncated ?? existing?.bTruncated,
          kind: bulkFormatKind,
          value: bulkFormatValue,
        });
      });
      return Array.from(byA.values());
    });
    setError("");
    setNotice(
      `Формат применён к выбранным опорным номерам: ${chosenANumbers.length}.`,
    );
  };

  const toggleBSelection = (aNumber: string, bNumber: string) => {
    setSelectedBByA((current) => {
      const selected = new Set(current[aNumber] ?? []);
      if (selected.has(bNumber)) selected.delete(bNumber);
      else selected.add(bNumber);
      const next = { ...current };
      if (selected.size) next[aNumber] = Array.from(selected);
      else delete next[aNumber];
      return next;
    });
  };

  const toggleAllBForA = (mapping: MappingOption) => {
    setSelectedBByA((current) => {
      const selected = new Set(current[mapping.aNumber] ?? []);
      const allSelected = mapping.bNumbers.every((item) => selected.has(item));
      if (allSelected) mapping.bNumbers.forEach((item) => selected.delete(item));
      else mapping.bNumbers.forEach((item) => selected.add(item));
      const next = { ...current };
      if (selected.size) next[mapping.aNumber] = Array.from(selected);
      else delete next[mapping.aNumber];
      return next;
    });
  };

  const toggleMappingFormat = (mapping: MappingOption) => {
    setMappingFormats((current) => {
      if (current.some((item) => item.aNumber === mapping.aNumber))
        return current.filter((item) => item.aNumber !== mapping.aNumber);
      return [
        ...current,
        {
          ...mapping,
          ...mappingFormatFromSource(mapping),
        },
      ];
    });
  };

  const updateMappingFormat = (
    aNumber: string,
    patch: Partial<Pick<MappingFormatSelection, "kind" | "value">>,
  ) => {
    setMappingFormats((current) =>
      current.map((item) =>
        item.aNumber === aNumber ? { ...item, ...patch } : item,
      ),
    );
  };

  const mappingFormatPreview = (
    selection: MappingFormatSelection,
    options: { full?: boolean } = {},
  ) => {
    const prefix = prefixForMappingFormat(selection);
    const firstB = selection.bNumbers[0] ?? selection.aNumber;
    const rest = selection.bNumbers
      .slice(1, options.full ? undefined : 4)
      .map(
        (bNumber) =>
          `;${template.nextBMarker},${template.weight},${bNumber}`,
      )
      .join("");
    const truncated =
      !options.full && selection.bNumbers.length > 4 ? ";…" : "";
    const terminator = selection.kind === "pani-region" ? ";" : "";
    return `${prefix}${selection.aNumber}=${template.firstBMarker},${template.weight},${firstB}${rest}${truncated}${terminator}`;
  };

  const addManualBatch = () => {
    const validNumber = /^\+?[0-9]+$/;
    const rows = batchManualText
      .split(/\r?\n/)
      .map((line) =>
        line
          .split(/[;,\t]+/)
          .filter((item) => item.trim().length > 0),
      )
      .filter((items) => items.length > 0);
    if (!rows.length) {
      setError("Добавьте хотя бы одну строку пакетного списка.");
      return;
    }
    const additions: MappingOption[] = [];
    for (const [index, rawItems] of rows.entries()) {
      const items = rawItems.map((item) => item.trim());
      const [aNumber, ...rawBNumbers] = items;
      const bNumbers = rawBNumbers.length ? rawBNumbers : [aNumber];
      if (
        !validNumber.test(aNumber.replace(/\s/g, "")) ||
        bNumbers.some((item) => !validNumber.test(item.replace(/\s/g, "")))
      ) {
        setError(
          `Проверьте строку ${index + 1}: ожидается «опорный; АОН; АОН».`,
        );
        return;
      }
      const selection: MappingFormatSelection = {
        aNumber,
        bNumbers,
        kind: newMappingFormatKind,
        value: newMappingFormatValue,
      };
      const formatError = mappingFormatError(selection);
      if (formatError) {
        setError(`Строка ${index + 1}: ${formatError}`);
        return;
      }
      additions.push({ aNumber, bNumbers });
    }
    setManualAdditions((current) => {
      const byA = new Map(
        current.map((item) => [item.aNumber, { ...item }]),
      );
      for (const addition of additions) {
        const existing = byA.get(addition.aNumber);
        byA.set(addition.aNumber, {
          aNumber: addition.aNumber,
          bNumbers: Array.from(
            new Set([
              ...(existing?.bNumbers ?? []),
              ...addition.bNumbers,
            ]),
          ),
        });
      }
      return Array.from(byA.values());
    });
    setMappingFormats((current) => {
      const byA = new Map(current.map((item) => [item.aNumber, item]));
      for (const addition of additions) {
        const existing = byA.get(addition.aNumber);
        byA.set(addition.aNumber, {
          aNumber: addition.aNumber,
          bNumbers: Array.from(
            new Set([
              ...(existing?.bNumbers ?? []),
              ...addition.bNumbers,
            ]),
          ),
          kind: newMappingFormatKind,
          value: newMappingFormatValue,
        });
      }
      return Array.from(byA.values());
    });
    setBatchManualText("");
    setError("");
    setNotice(`Пакетно добавлено связок: ${additions.length}.`);
  };

  const applyANumberEdit = async (mapping: MappingOption) => {
    const previous = mapping.aNumber;
    const rawNext = aNumberEditValues[previous] ?? previous;
    const next = rawNext.replace(/^\+/, "");
    if (!/^\d[\d\s]*$/.test(next)) {
      setError("Опорный номер должен состоять только из цифр.");
      return;
    }
    if (next === previous) {
      setError("");
      setNotice("Опорный номер не изменился.");
      return;
    }
    if (allEditorMappings.some((item) => item.aNumber === next)) {
      setError(`Опорный номер ${next} уже есть в загруженном списке.`);
      return;
    }

    const isUploadedMapping = mappingOptions.some(
      (item) => item.aNumber === previous,
    );
    if (upload && isUploadedMapping) {
      try {
        const response = await apiFetch(
          `/api/uploads/${upload.id}/mappings`,
          {
            method: "POST",
            body: JSON.stringify({
              sheet: sheet || null,
              mode: inspection?.mode ?? "auto",
              aColumn,
              bColumn,
              query: next,
              offset: 0,
              limit: 2,
            }),
          },
        );
        const payload = (await response.json().catch(() => null)) as
          | MappingOptionsResponse
          | null;
        if (!response.ok) throw parseApiError(payload, response.status);
        if (payload?.items.some((item) => item.aNumber === next)) {
          setError(`Опорный номер ${next} уже есть в загруженном файле.`);
          return;
        }
      } catch (requestError) {
        setError(getErrorMessage(requestError));
        return;
      }
    }

    const replaceNumber = (value: string) =>
      value === previous ? next : value;
    const replaceMapping = (item: MappingOption) =>
      item.aNumber === previous
        ? {
            ...item,
            aNumber: next,
            bNumbers: item.bNumbers.map(replaceNumber),
          }
        : item;
    const replaceList = (items: string[]) =>
      Array.from(new Set(items.map(replaceNumber)));

    setRenameANumbers((current) => {
      const existing = current.find(
        (item) => item.toANumber === previous,
      );
      if (existing) {
        if (existing.fromANumber === next)
          return current.filter((item) => item !== existing);
        return current.map((item) =>
          item === existing ? { ...item, toANumber: next } : item,
        );
      }
      return isUploadedMapping
        ? [...current, { fromANumber: previous, toANumber: next }]
        : current;
    });
    setMappingOptions((current) => current.map(replaceMapping));
    setManualAdditions((current) => current.map(replaceMapping));
    setMappingFormats((current) =>
      current.map((item) =>
        item.aNumber === previous
          ? {
              ...item,
              aNumber: next,
              bNumbers: item.bNumbers.map(replaceNumber),
            }
          : item,
      ),
    );
    setChosenANumbers(replaceList);
    setExpandedANumbers(replaceList);
    setSelectedANumbers(replaceList);
    setANumbersText((current) =>
      parseANumbers(current).map(replaceNumber).join("\n"),
    );
    setSelectedBByA((current) => {
      const result: Record<string, string[]> = {};
      Object.entries(current).forEach(([aNumber, bNumbers]) => {
        result[replaceNumber(aNumber)] = replaceList(bNumbers);
      });
      return result;
    });
    setBAdditionsByA((current) => {
      const result = { ...current };
      if (Object.prototype.hasOwnProperty.call(result, previous)) {
        result[next] = result[previous];
        delete result[previous];
      }
      return result;
    });
    setANumberEditValues((current) => {
      const result = { ...current };
      delete result[previous];
      return result;
    });
    setActiveDuplicate(null);
    setError("");
    setNotice(
      next.length === 11
        ? `Опорный номер исправлен: ${previous} → ${next}.`
        : `Опорный номер изменён на ${next}. В нём ${next.length} символов вместо 11 — проверьте значение перед формированием CSV.`,
    );
  };

  const addBToMapping = (aNumber: string) => {
    const entries = editableNumberEntries(bAdditionsByA[aNumber] ?? "");
    const requested = Array.from(
      new Set(entries.map((entry) => entry.value.replace(/^\+/, ""))),
    );
    const validNumber = /^\+?[0-9]+$/;
    if (!requested.length) {
      setError("Укажите хотя бы один АОН.");
      return;
    }
    if (requested.some((item) => !validNumber.test(item.replace(/\s/g, "")))) {
      setError(
        `Опорный номер ${aNumber}: проверьте корректность добавляемых АОН.`,
      );
      return;
    }
    const existing = new Set(
      editorMappings.find((item) => item.aNumber === aNumber)?.bNumbers ?? [],
    );
    const additions = requested.filter((item) => !existing.has(item));
    if (!additions.length) {
      setError("");
      setNotice(
        `Все указанные АОН уже привязаны к опорному номеру ${aNumber}.`,
      );
      return;
    }
    setManualAdditions((current) => {
      const manual = current.find((item) => item.aNumber === aNumber);
      if (!manual) return [...current, { aNumber, bNumbers: additions }];
      return current.map((item) =>
        item.aNumber === aNumber
          ? {
              ...item,
              bNumbers: Array.from(
                new Set([...item.bNumbers, ...additions]),
              ),
            }
          : item,
      );
    });
    setBAdditionsByA((current) => ({ ...current, [aNumber]: "" }));
    setError("");
    setNotice(
      `К опорному номеру ${aNumber} добавлено АОН: ${additions.length}.`,
    );
  };

  const removeManualMapping = (aNumber: string) => {
    const manualB = new Set(
      manualAdditions.find((item) => item.aNumber === aNumber)?.bNumbers ?? [],
    );
    setManualAdditions((current) =>
      current.filter((item) => item.aNumber !== aNumber),
    );
    setMappingFormats((current) =>
      current.filter((item) => item.aNumber !== aNumber),
    );
    setChosenANumbers((current) =>
      current.filter((item) => item !== aNumber),
    );
    setExpandedANumbers((current) =>
      current.filter((item) => item !== aNumber),
    );
    setSelectedBByA((current) => {
      const remaining = (current[aNumber] ?? []).filter(
        (bNumber) => !manualB.has(bNumber),
      );
      const next = { ...current };
      if (remaining.length) next[aNumber] = remaining;
      else delete next[aNumber];
      return next;
    });
  };

  const removeManualB = (aNumber: string, bNumber: string) => {
    setManualAdditions((current) =>
      current.map((item) => {
        if (item.aNumber !== aNumber) return item;
        const bNumbers = item.bNumbers.filter((value) => value !== bNumber);
        return {
          ...item,
          bNumbers: bNumbers.length ? bNumbers : [aNumber],
        };
      }),
    );
    setMappingFormats((current) =>
      current.map((item) => {
        if (item.aNumber !== aNumber) return item;
        const bNumbers = item.bNumbers.filter(
          (value) => value !== bNumber,
        );
        return {
          ...item,
          bNumbers: bNumbers.length ? bNumbers : [aNumber],
        };
      }),
    );
    setSelectedBByA((current) => {
      const selected = (current[aNumber] ?? []).filter(
        (value) => value !== bNumber,
      );
      const next = { ...current };
      if (selected.length) next[aNumber] = selected;
      else delete next[aNumber];
      return next;
    });
  };

  const startJob = async () => {
    if (!upload) return setError("Сначала загрузите исходный файл.");
    if (!mappingConfirmed)
      return setError("Подтвердите лист и сопоставление колонок.");
    if (duplicateCount > 0 && duplicateDecision === null)
      return setError(
        "Выберите, оставить или удалить найденные дубликаты.",
      );
    const invalidFormat = mappingFormats.find(mappingFormatError);
    if (invalidFormat)
      return setError(
        `Опорный номер ${invalidFormat.aNumber}: ${mappingFormatError(invalidFormat)}`,
      );
    if (bulkDeleteBNumbers.some((item) => !/^\+?[0-9]+$/.test(item)))
      return setError(
        "Проверьте список пакетного удаления АОН: допускаются только номера из цифр.",
      );
    if (
      template.regionCode &&
      (Number(template.regionCode) < 1 || Number(template.regionCode) > 84)
    )
      return setError("Код региона в настройках CSV должен быть числом от 1 до 84.");
    setJobStarting(true);
    setError("");
    setNotice("");
    setJob(null);
    setResultPreview("");
    const resolvedMode =
      mode === "auto"
        ? inspection?.mode === "formatted"
          ? "formatted"
          : "raw"
        : mode;
    const body: Record<string, unknown> = {
      uploadId: upload.id,
      mode: resolvedMode,
      sheet: sheet || null,
      aColumn,
      bColumn,
      keepDuplicateB,
      additions: manualAdditions,
      renameANumbers,
      deleteANumbers: aNumbers,
      deleteBCommands: bCommands,
      deleteBNumbers: bulkDeleteBNumbers,
      deleteACommandUploadId: commandUpload?.id ?? null,
      mappingFormats: mappingFormats.map((item) => ({
        aNumber: item.aNumber,
        prefix: prefixForMappingFormat(item),
      })),
      csv,
      template,
    };
    try {
      const response = await apiFetch("/api/jobs/convert", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => null)) as
        | { jobId?: string; status?: JobStatus }
        | null;
      if (!response.ok) throw parseApiError(payload, response.status);
      if (!payload?.jobId) throw new ApiError("Сервер не создал задание.");
      setJob({
        id: payload.jobId,
        status: payload.status ?? "queued",
        progress: 0,
      });
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setJobStarting(false);
    }
  };

  useEffect(() => {
    if (!job?.id || ["completed", "failed", "cancelled"].includes(job.status))
      return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      pollAbortRef.current?.abort();
      const controller = new AbortController();
      pollAbortRef.current = controller;
      try {
        const response = await apiFetch(`/api/jobs/${job.id}`, {
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => null)) as Job | null;
        if (!response.ok) throw parseApiError(payload, response.status);
        if (!payload)
          throw new ApiError("Не удалось получить статус задания.");
        if (!stopped) {
          setJob(payload);
          if (payload.status === "failed")
            setError(getErrorMessage(payload.error));
        }
      } catch (requestError) {
        if (
          !stopped &&
          !(requestError instanceof DOMException &&
            requestError.name === "AbortError")
        )
          setError(getErrorMessage(requestError));
      } finally {
        if (!stopped) timer = setTimeout(poll, 1200);
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      pollAbortRef.current?.abort();
    };
  }, [apiFetch, job?.id, job?.status]);

  const cancelJob = async () => {
    if (!job?.id || !isRunning) return;
    setCancelling(true);
    setError("");
    try {
      const response = await apiFetch(`/api/jobs/${job.id}/cancel`, {
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as Job | null;
      if (!response.ok) throw parseApiError(payload, response.status);
      if (!payload)
        throw new ApiError("Сервер не подтвердил запрос на отмену.");
      setJob(payload);
      setNotice(
        payload.status === "cancelled"
          ? "Задание отменено. Исходный файл не изменён."
          : "Отмена запрошена. Ждём остановки текущего этапа.",
      );
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setCancelling(false);
    }
  };
  const downloadEndpoint = async (
    suffix: "download" | "preview",
    fallbackName: string,
  ) => {
    if (!job?.id) return;
    setDownloading(suffix);
    setError("");
    try {
      const response = await apiFetch(`/api/jobs/${job.id}/${suffix}`);
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw parseApiError(payload, response.status);
      }
      if (suffix === "preview") {
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const payload = await response.json();
          if (payload && typeof payload === "object" && "preview" in payload) {
            const value = (payload as Record<string, unknown>).preview;
            setResultPreview(
              typeof value === "string"
                ? value
                : JSON.stringify(value, null, 2),
            );
          } else if (
            payload &&
            typeof payload === "object" &&
            "header" in payload &&
            "rows" in payload
          ) {
            const preview = payload as {
              header?: unknown;
              rows?: unknown;
              truncated?: unknown;
            };
            const lines = [
              typeof preview.header === "string"
                ? preview.header
                : JSON.stringify(preview.header),
              ...(Array.isArray(preview.rows)
                ? preview.rows.map((row) =>
                    typeof row === "string" ? row : JSON.stringify(row),
                  )
                : []),
            ].filter(Boolean);
            if (preview.truncated)
              lines.push("… показан только фрагмент результата");
            setResultPreview(lines.join("\n"));
          } else setResultPreview(JSON.stringify(payload, null, 2));
        } else setResultPreview(await response.text());
        return true;
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const plainName = disposition.match(/filename="?([^";]+)"?/i)?.[1];
      const fileName = encodedName
        ? decodeURIComponent(encodedName)
        : plainName || fallbackName;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      if (
        suffix === "download" &&
        tutorialOpen &&
        tutorialStepId === "download-result"
      )
        setTutorialDownloadedResult(true);
      return true;
    } catch (requestError) {
      setError(getErrorMessage(requestError));
      return false;
    } finally {
      setDownloading("");
    }
  };
  const prepareEmail = async () => {
    if (!job?.id) return;
    setEmailing(true);
    const downloaded = await downloadEndpoint("download", "result.csv");
    if (downloaded) {
      const subject = encodeURIComponent(
        "Готовый файл с опорными номерами и АОН",
      );
      const body = encodeURIComponent(
        "Здравствуйте!\n\nНаправляю подготовленный CSV-файл с опорными номерами и АОН.\n\nФайл уже скачан на устройство — прикрепите result.csv к этому письму перед отправкой.",
      );
      window.location.href = `mailto:${EMAIL_RECIPIENT}?subject=${subject}&body=${body}`;
      setNotice(
        `CSV скачан. Письмо для ${EMAIL_RECIPIENT} подготовлено — осталось прикрепить файл и нажать «Отправить».`,
      );
    }
    setEmailing(false);
  };
  const sendToMaster = async () => {
    if (!job?.id || !user?.canAccessMaster) return;
    setDownloading("master");
    setError("");
    try {
      const response = await apiFetch(
        `/api/jobs/${job.id}/send-to-master`,
        { method: "POST" },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok)
        throw parseApiError(payload, response.status);
      if (!payload?.uploadId)
        throw new ApiError("Не удалось подготовить файл для мастер-файла.");
      persistTutorial("completed", "complete");
      window.location.assign(
        `/master?importUploadId=${encodeURIComponent(
          payload.uploadId,
        )}&tutorial=master`,
      );
    } catch (requestError) {
      setError(getErrorMessage(requestError));
      setDownloading("");
    }
  };
  const continueEditing = () => {
    setJob(null);
    setResultPreview("");
    setNotice("Все выбранные изменения сохранены. Можно продолжить редактирование.");
    setCollapsedSections(collapsedSectionState("editor"));
    window.setTimeout(
      () => editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      0,
    );
  };
  const toggleSection = (section: CollapsibleSection) => {
    setCollapsedSections((current) =>
      current[section]
        ? collapsedSectionState(section)
        : collapsedSectionState(null),
    );
  };
  const resetAll = () => {
    pollAbortRef.current?.abort();
    mappingsAbortRef.current?.abort();
    setUpload(null);
    setInspection(null);
    setJob(null);
    setCommandUpload(null);
    setANumbersText("");
    setBulkDeleteBText("");
    setMappingOptions([]);
    setMappingTotal(0);
    setMappingQuery("");
    setMappingFilterOpen(false);
    setSelectedMappingParameterGroups([]);
    setMappingsError("");
    setSelectingAllANumbers(false);
    setChosenANumbers([]);
    setExpandedANumbers([]);
    setBulkFormatKind("default");
    setBulkFormatValue("");
    setSelectedANumbers([]);
    setSelectedBByA({});
    setNewMappingFormatKind("default");
    setNewMappingFormatValue("");
    setManualAdditions([]);
    setBAdditionsByA({});
    setMappingFormats([]);
    setRenameANumbers([]);
    setANumberEditValues({});
    setResultPreview("");
    setError("");
    setNotice("");
    setMappingConfirmed(false);
    setDuplicateDecision(null);
    setDuplicateCursor(0);
    setActiveDuplicate(null);
    setDuplicateNavigating(false);
    setStartVariant(null);
    setMode("auto");
    setSheet("");
    setTemplate(DEFAULT_TEMPLATE);
    setPreviewTab("final");
    setTutorialDownloadedResult(false);
    setCollapsedSections(collapsedSectionState("upload"));
  };

  const tutorialStorageKey = user?.id
    ? `carousel-request-tutorial:${REQUEST_TUTORIAL_STORAGE_VERSION}:${user.id}`
    : "";
  const currentTutorialStep =
    REQUEST_TUTORIAL_STEPS.find((item) => item.id === tutorialStepId) ??
    REQUEST_TUTORIAL_STEPS[0];
  const currentTutorialIndex = REQUEST_TUTORIAL_STEPS.findIndex(
    (item) => item.id === currentTutorialStep.id,
  );
  const numberedTutorialSteps = REQUEST_TUTORIAL_STEPS.filter(
    (item) => item.id !== "welcome" && item.id !== "complete",
  );
  const numberedTutorialIndex = numberedTutorialSteps.findIndex(
    (item) => item.id === currentTutorialStep.id,
  );
  const tutorialTargetSelector =
    currentTutorialStep.id === "upload-file" && upload
      ? '[data-tour="upload-section"]'
      : currentTutorialStep.target;
  const tutorialSinglePaniApplied =
    !!tutorialPrimaryANumber &&
    mappingFormats.some(
      (selection) =>
        selection.aNumber === tutorialPrimaryANumber &&
        selection.kind === "linked-a" &&
        selection.value === bulkFormatValue &&
        /^\d{11}$/.test(selection.value),
    );
  const tutorialAllANumbersChosen =
    editorMappings.length > 0 &&
    editorMappings.every((mapping) =>
      chosenANumbers.includes(mapping.aNumber),
    );
  const tutorialAllANumbersDeleted =
    chosenANumbers.length > 0 &&
    chosenANumbers.every((aNumber) => aNumbers.includes(aNumber));
  const tutorialAllANumbersRestored =
    chosenANumbers.length > 0 &&
    chosenANumbers.every((aNumber) => !aNumbers.includes(aNumber));
  const tutorialBulkPaniApplied =
    chosenANumbers.length > 0 &&
    /^\d{11}$/.test(bulkFormatValue) &&
    chosenANumbers.every((aNumber) =>
      mappingFormats.some(
        (selection) =>
          selection.aNumber === aNumber &&
          selection.kind === "linked-a" &&
          selection.value === bulkFormatValue,
      ),
    );
  const tutorialActionComplete = (() => {
    switch (tutorialStepId) {
      case "select-raw":
        return startVariant === "raw";
      case "upload-file":
        return !!upload && !!inspection && !uploading && !inspecting;
      case "confirm-import":
        return (
          mappingConfirmed &&
          !mappingsLoading &&
          editorMappings.length > 0
        );
      case "connection-search":
        return (
          !!normalizedMappingQuery && searchMatchedANumbers.length > 0
        );
      case "select-connection":
        return chosenANumbers.length > 0;
      case "single-pani-kind":
      case "bulk-pani-kind":
        return bulkFormatKind === "linked-a";
      case "single-pani-value":
      case "bulk-pani-value":
        return /^\d{11}$/.test(bulkFormatValue);
      case "single-pani-apply":
        return tutorialSinglePaniApplied;
      case "expand-connection":
        return (
          !!tutorialPrimaryANumber &&
          expandedANumbers.includes(tutorialPrimaryANumber)
        );
      case "add-aon":
        return !!tutorialAddedAon;
      case "remove-added-aon":
        return (
          !!tutorialAddedAon &&
          (selectedBByA[tutorialPrimaryANumber] ?? []).includes(
            tutorialAddedAon,
          )
        );
      case "select-all-a":
        return tutorialAllANumbersChosen;
      case "delete-all-a":
        return tutorialAllANumbersDeleted;
      case "restore-all-a":
        return tutorialAllANumbersRestored;
      case "bulk-pani-apply":
        return tutorialBulkPaniApplied;
      case "parameter-filter":
        return mappingFilterOpen;
      case "generate":
        return isComplete;
      case "download-result":
        return tutorialDownloadedResult;
      default:
        return false;
    }
  })();
  const tutorialActionSteps = new Set<RequestTutorialStepId>([
    "select-raw",
    "upload-file",
    "confirm-import",
    "connection-search",
    "select-connection",
    "single-pani-kind",
    "single-pani-value",
    "single-pani-apply",
    "expand-connection",
    "add-aon",
    "remove-added-aon",
    "select-all-a",
    "delete-all-a",
    "restore-all-a",
    "bulk-pani-kind",
    "bulk-pani-value",
    "bulk-pani-apply",
    "parameter-filter",
    "generate",
    "download-result",
  ]);
  const tutorialActionPending =
    tutorialActionSteps.has(tutorialStepId) && !tutorialActionComplete;
  const tutorialActionCopy =
    tutorialStepId === "connection-search" && editorMappings[0]?.aNumber
      ? `Введите в выделенное поле запрос. Например, опорный номер ${editorMappings[0].aNumber}.`
      : tutorialStepId === "send-to-master" && !user?.canAccessMaster
        ? "У вас пока нет доступа к мастер-файлу. Попросите суперюзера выдать разрешение и завершите этот шаг кнопкой «Далее»."
        : currentTutorialStep.action;
  const tutorialPendingButtonLabel =
    tutorialStepId === "select-raw"
      ? "Выберите карточку"
      : tutorialStepId === "upload-file"
        ? "Загрузите файл"
        : tutorialStepId === "generate" && isRunning
          ? "Формируем CSV…"
          : tutorialStepId === "download-result"
            ? "Скачайте CSV"
            : "Выполните действие";

  const persistTutorial = useCallback(
    (status: RequestTutorialStatus, step: RequestTutorialStepId) => {
      if (!tutorialStorageKey || typeof localStorage === "undefined") return;
      const payload: StoredRequestTutorial = { status, step };
      localStorage.setItem(tutorialStorageKey, JSON.stringify(payload));
    },
    [tutorialStorageKey],
  );

  useEffect(() => {
    if (
      !tutorialStorageKey ||
      tutorialInitializedForRef.current === tutorialStorageKey
    )
      return;
    tutorialInitializedForRef.current = tutorialStorageKey;
    let stored: StoredRequestTutorial | null = null;
    try {
      const raw = localStorage.getItem(tutorialStorageKey);
      if (raw) stored = JSON.parse(raw) as StoredRequestTutorial;
    } catch {
      localStorage.removeItem(tutorialStorageKey);
    }
    const validStep = REQUEST_TUTORIAL_STEPS.some(
      (item) => item.id === stored?.step,
    );
    const validStatus = ["active", "dismissed", "completed"].includes(
      stored?.status ?? "",
    );
    const timer = window.setTimeout(() => {
      if (!stored || !validStep || !validStatus) {
        setTutorialStatus("active");
        setTutorialStepId("welcome");
        setTutorialOpen(true);
        return;
      }
      setTutorialStatus(stored.status);
      setTutorialStepId(
        stored.status === "active" &&
          !["welcome", "select-raw"].includes(stored.step)
          ? "select-raw"
          : stored.step,
      );
      setTutorialOpen(stored.status === "active");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [tutorialStorageKey]);

  useEffect(() => {
    if (!tutorialOpen) return;
    persistTutorial("active", tutorialStepId);
  }, [persistTutorial, tutorialOpen, tutorialStepId]);

  useEffect(() => {
    if (!tutorialOpen || tutorialBackNavigationRef.current) return;
    const timer = window.setTimeout(() => {
      if (tutorialBackNavigationRef.current) return;
      if (tutorialStepId === "select-raw" && startVariant === "raw") {
        setTutorialStepId("upload-file");
        return;
      }
      if (
        tutorialStepId === "upload-file" &&
        upload &&
        inspection &&
        !uploading &&
        !inspecting
      )
        setTutorialStepId("import-parameters");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    inspecting,
    inspection,
    startVariant,
    tutorialOpen,
    tutorialStepId,
    upload,
    uploading,
  ]);

  useEffect(() => {
    if (
      !tutorialOpen ||
      !tutorialActionComplete ||
      tutorialBackNavigationRef.current ||
      REQUEST_TUTORIAL_MANUAL_CONFIRMATION_STEPS.has(tutorialStepId)
    )
      return;
    const next = REQUEST_TUTORIAL_STEPS[currentTutorialIndex + 1];
    if (!next) return;
    const timer = window.setTimeout(() => {
      if (tutorialBackNavigationRef.current) return;
      if (tutorialStepId === "restore-all-a") {
        setBulkFormatKind("default");
        setBulkFormatValue("");
      }
      if (tutorialStepId === "bulk-pani-apply")
        setMappingFilterOpen(false);
      if (tutorialStepId === "remove-added-aon")
        setMappingQuery("");
      if (tutorialStepId === "single-pani-apply") {
        setMappingQuery("");
        setExpandedANumbers((current) =>
          current.filter((aNumber) => aNumber !== tutorialPrimaryANumber),
        );
      }
      setTutorialStepId(next.id);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [
    currentTutorialIndex,
    tutorialActionComplete,
    tutorialOpen,
    tutorialPrimaryANumber,
    tutorialStepId,
  ]);

  useEffect(() => {
    if (!tutorialOpen) return;
    const sectionByStep: Partial<
      Record<RequestTutorialStepId, CollapsibleSection>
    > = {
      "import-parameters": "import",
      "confirm-import": "import",
      "connection-search": "editor",
      "select-connection": "editor",
      "single-pani-kind": "editor",
      "single-pani-value": "editor",
      "single-pani-apply": "editor",
      "expand-connection": "editor",
      "add-aon": "editor",
      "remove-added-aon": "editor",
      "select-all-a": "editor",
      "delete-all-a": "editor",
      "restore-all-a": "editor",
      "bulk-pani-kind": "editor",
      "bulk-pani-value": "editor",
      "bulk-pani-apply": "editor",
      "parameter-filter": "editor",
      "parameter-filter-options": "editor",
      "bulk-delete-b": "bulkDeleteB",
      "bulk-delete-a": "bulkDeleteA",
      "batch-add": "batchAdd",
      preview: "preview",
    };
    const section = sectionByStep[tutorialStepId];
    if (tutorialStepId === "csv-settings") {
      const details = document.querySelector<HTMLDetailsElement>(
        '[data-tour="csv-settings"] details',
      );
      if (details) details.open = true;
    }

    document.body.classList.add("request-tutorial-active");
    document
      .querySelectorAll(".request-tutorial-focus")
      .forEach((element) =>
        element.classList.remove("request-tutorial-focus"),
      );
    document
      .querySelectorAll(".request-tutorial-context")
      .forEach((element) =>
        element.classList.remove("request-tutorial-context"),
      );
    let target: Element | null = null;
    let context: Element | null = null;
    let nestedFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      if (section) {
        setCollapsedSections(collapsedSectionState(section));
      }
      nestedFrame = window.requestAnimationFrame(() => {
        if (!tutorialTargetSelector) return;
        target = document.querySelector(tutorialTargetSelector);
        if (!target) return;
        context = target.closest(
          '[data-tour="upload-section"], [data-tour="import-parameters"], [data-tour="connections-editor"], [data-tour="bulk-delete-b"], [data-tour="bulk-delete-a"], [data-tour="batch-add"], [data-tour="preview"], [data-tour="csv-settings"], .job-card, .submit-bar, .result-master-offer',
        );
        if (context && context !== target)
          context.classList.add("request-tutorial-context");
        target.classList.add("request-tutorial-focus");
        target.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "auto"
            : "smooth",
          block: "center",
        });
        if (tutorialStepId === "connection-search") {
          window.setTimeout(() => mappingSearchInputRef.current?.focus(), 180);
        }
      });
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setTutorialOpen(false);
      setTutorialStatus("dismissed");
      persistTutorial("dismissed", tutorialStepId);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      if (nestedFrame) window.cancelAnimationFrame(nestedFrame);
      window.removeEventListener("keydown", handleKeyDown);
      target?.classList.remove("request-tutorial-focus");
      context?.classList.remove("request-tutorial-context");
      document.body.classList.remove("request-tutorial-active");
    };
  }, [
    persistTutorial,
    tutorialOpen,
    tutorialStepId,
    tutorialTargetSelector,
  ]);

  const beginTutorial = () => {
    resetAll();
    tutorialBackNavigationRef.current = false;
    setTutorialStatus("active");
    setTutorialStepId("select-raw");
    setTutorialOpen(true);
    setTutorialDownloadedResult(false);
    persistTutorial("active", "select-raw");
  };
  const dismissTutorial = () => {
    setTutorialOpen(false);
    setTutorialStatus("dismissed");
    persistTutorial("dismissed", tutorialStepId);
  };
  const openTutorial = () => {
    tutorialBackNavigationRef.current = false;
    if (tutorialStatus === "completed" || startVariant === "formatted") {
      setTutorialStepId("welcome");
    } else if (
      currentTutorialIndex >=
        REQUEST_TUTORIAL_STEPS.findIndex(
          (item) => item.id === "import-parameters",
        ) &&
      !upload
    ) {
      setTutorialStepId(startVariant === "raw" ? "upload-file" : "select-raw");
    } else if (
      tutorialStepId === "select-raw" &&
      startVariant === "raw"
    ) {
      setTutorialStepId("upload-file");
    }
    setTutorialStatus("active");
    setTutorialOpen(true);
  };
  const completeTutorial = () => {
    setTutorialOpen(false);
    setTutorialStatus("completed");
    persistTutorial("completed", "complete");
    setNotice(
      "Обучение по обработке заявки завершено. Его можно повторить в любой момент.",
    );
  };
  const goToPreviousTutorialStep = () => {
    if (currentTutorialIndex <= 0) return;
    tutorialBackNavigationRef.current = true;
    if (tutorialStepId === "upload-file" && !upload) {
      setStartVariant(null);
      setMode("auto");
    }
    setTutorialStepId(
      REQUEST_TUTORIAL_STEPS[currentTutorialIndex - 1].id,
    );
  };
  const goToNextTutorialStep = () => {
    tutorialBackNavigationRef.current = false;
    if (tutorialStepId === "welcome") {
      beginTutorial();
      return;
    }
    if (
      tutorialStepId === "select-raw" ||
      (tutorialStepId === "upload-file" && !upload)
    )
      return;
    const next = REQUEST_TUTORIAL_STEPS[currentTutorialIndex + 1];
    if (!next) return;
    if (tutorialStepId === "restore-all-a") {
      setBulkFormatKind("default");
      setBulkFormatValue("");
    }
    if (tutorialStepId === "bulk-pani-apply")
      setMappingFilterOpen(false);
    if (tutorialStepId === "remove-added-aon") setMappingQuery("");
    if (tutorialStepId === "single-pani-apply") {
      setMappingQuery("");
      setExpandedANumbers((current) =>
        current.filter((aNumber) => aNumber !== tutorialPrimaryANumber),
      );
    }
    setTutorialStepId(next.id);
  };

  const step = isComplete ? 3 : upload && inspection ? 2 : 1;
  const previewRows = Array.isArray(inspection?.preview)
    ? inspection.preview
    : [];
  const visibleSourcePreviewRows = previewRows;
  const finalPreviewRows = allEditorMappings.map((mapping) => {
    const sourceMapping = mappingOptions.find(
      (item) => item.aNumber === mapping.aNumber,
    );
    const manualMapping = manualAdditions.find(
      (item) => item.aNumber === mapping.aNumber,
    );
    const workingBNumbers = Array.from(
      new Set([
        ...(sourceMapping &&
        sourceMapping.bNumbers.length === 0 &&
        !sourceMapping.bTruncated
          ? [mapping.aNumber]
          : []),
        ...mapping.bNumbers,
      ]),
    );
    const selectedForRemoval = new Set(
      selectedBByA[mapping.aNumber] ?? [],
    );
    const globallyRemoved = new Set(bulkDeleteBNumbers);
    const remainingAfterDeletion = workingBNumbers.filter(
      (bNumber) =>
        !selectedForRemoval.has(bNumber) &&
        !globallyRemoved.has(bNumber),
    );
    const removedBNumbers = workingBNumbers.filter(
      (bNumber) => !remainingAfterDeletion.includes(bNumber),
    );
    const removed =
      aNumbers.includes(mapping.aNumber) ||
      (!mapping.bTruncated &&
        workingBNumbers.length > 0 &&
        remainingAfterDeletion.length === 0);
    const remainingBNumbers = remainingAfterDeletion;
    const formatSelection =
      mappingFormats.find((item) => item.aNumber === mapping.aNumber) ?? {
        ...mapping,
        ...mappingFormatFromSource(mapping),
      };
    const previewBNumbers = removed ? workingBNumbers : remainingBNumbers;
    const added = !sourceMapping && !!manualMapping;
    const changed =
      !removed &&
      (added ||
        !!manualMapping ||
        removedBNumbers.length > 0 ||
        mappingFormats.some(
          (item) => item.aNumber === mapping.aNumber,
        ));
    return {
      aNumber: mapping.aNumber,
      bNumbers: remainingBNumbers,
      removedBNumbers,
      linkedANumber: mapping.linkedANumber,
      removed,
      added,
      changed,
      truncated: mapping.bTruncated === true,
      line: mappingFormatPreview(
        {
          ...formatSelection,
          bNumbers: previewBNumbers,
        },
        { full: true },
      ),
    };
  });
  const visibleFinalPreviewRows = finalPreviewRows;
  const numberStartViolations = finalPreviewRows.flatMap((row) => {
    if (row.removed) return [];
    const violations: Array<{
      kind: "a" | "b";
      number: string;
      aNumber: string;
    }> = [];
    if (!numberStartsWithSeven(row.aNumber))
      violations.push({
        kind: "a",
        number: row.aNumber,
        aNumber: row.aNumber,
      });
    row.bNumbers.forEach((bNumber) => {
      if (!numberStartsWithSeven(bNumber))
        violations.push({
          kind: "b",
          number: bNumber,
          aNumber: row.aNumber,
        });
    });
    return violations;
  });
  const aNumberStartWarnings = numberStartViolations.filter(
    (violation) => violation.kind === "a",
  );
  const aonNumberStartWarnings = numberStartViolations.filter(
    (violation) => violation.kind === "b",
  );
  const numberWhitespaceViolations = finalPreviewRows.flatMap((row) => {
    if (row.removed) return [];
    const violations: Array<{
      kind: "a" | "b";
      number: string;
      aNumber: string;
    }> = [];
    if (hasNumberWhitespace(row.aNumber))
      violations.push({
        kind: "a",
        number: row.aNumber,
        aNumber: row.aNumber,
      });
    row.bNumbers.forEach((bNumber) => {
      if (hasNumberWhitespace(bNumber))
        violations.push({
          kind: "b",
          number: bNumber,
          aNumber: row.aNumber,
        });
    });
    return violations;
  });
  const finalActiveCount = finalPreviewRows.filter(
    (row) => !row.removed,
  ).length;
  const finalRemovedCount = finalPreviewRows.length - finalActiveCount;
  const summaryEntries = Object.entries(job?.summary ?? {})
    .filter(
      ([key, value]) =>
        (typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean") &&
        (Number(value) !== 0 ||
          ["inputRows", "uniqueA", "resultRows", "resultSize"].includes(key)),
    )
    .sort(([left], [right]) => {
      const leftIndex = SUMMARY_PRIORITY.indexOf(left);
      const rightIndex = SUMMARY_PRIORITY.indexOf(right);
      return (
        (leftIndex === -1 ? SUMMARY_PRIORITY.length : leftIndex) -
        (rightIndex === -1 ? SUMMARY_PRIORITY.length : rightIndex)
      );
    })
    .slice(0, 8);

  return (
    <main className="app-shell">
      <AppHeader />

      {!tutorialOpen && (
        <button
          className="request-tutorial-launcher"
          type="button"
          onClick={openTutorial}
          aria-label={
            tutorialStatus === "completed"
              ? "Повторить обучение по обработке заявки"
              : "Продолжить обучение по обработке заявки"
          }
        >
          <span aria-hidden="true">?</span>
          <span>
            <strong>Обучение</strong>
            <small>
              {tutorialStatus === "completed" ? "Пройти ещё раз" : "Продолжить"}
            </small>
          </span>
        </button>
      )}

      {tutorialOpen && (
        <div
          className="request-tutorial-layer"
          data-tutorial-step={currentTutorialStep.id}
        >
          <div className="request-tutorial-backdrop" aria-hidden="true" />
          <aside
            className="request-tutorial-coach"
            role="region"
            aria-labelledby="request-tutorial-title"
            aria-describedby="request-tutorial-description"
          >
            <div className="request-tutorial-coach-header">
              <div className="request-tutorial-assistant">
                <span aria-hidden="true">t2</span>
                <div>
                  <strong>Помощник по обучению</strong>
                  <small>Обработка заявки на добавление номеров</small>
                </div>
              </div>
              <button
                type="button"
                onClick={dismissTutorial}
                aria-label="Выйти из обучения"
              >
                ×
              </button>
            </div>

            <div className="request-tutorial-progress-row">
              <span>
                {currentTutorialStep.id === "welcome"
                  ? "Вводная сессия"
                  : currentTutorialStep.id === "complete"
                    ? "Обучение завершено"
                    : `Шаг ${numberedTutorialIndex + 1} из ${numberedTutorialSteps.length}`}
              </span>
              {numberedTutorialIndex >= 0 && (
                <strong>
                  {Math.round(
                    ((numberedTutorialIndex + 1) /
                      numberedTutorialSteps.length) *
                      100,
                  )}
                  %
                </strong>
              )}
            </div>
            {numberedTutorialIndex >= 0 && (
              <div
                className="request-tutorial-progress"
                role="progressbar"
                aria-label="Прогресс обучения"
                aria-valuemin={1}
                aria-valuemax={numberedTutorialSteps.length}
                aria-valuenow={numberedTutorialIndex + 1}
              >
                <span
                  style={{
                    width: `${
                      ((numberedTutorialIndex + 1) /
                        numberedTutorialSteps.length) *
                      100
                    }%`,
                  }}
                />
              </div>
            )}

            <div className="request-tutorial-copy">
              <h2 id="request-tutorial-title">
                {currentTutorialStep.title}
              </h2>
              <p id="request-tutorial-description">
                {currentTutorialStep.description}
              </p>
              <div className="request-tutorial-action">
                <span aria-hidden="true">→</span>
                <p>{tutorialActionCopy}</p>
              </div>
              {currentTutorialStep.id === "welcome" &&
                (upload || startVariant) && (
                  <div className="request-tutorial-reset-warning" role="note">
                    Для начала обучения текущая несохранённая настройка заявки
                    будет очищена. Исходный файл останется без изменений.
                  </div>
                )}
              {currentTutorialStep.id === "select-raw" && (
                <div className="request-tutorial-wait" role="status">
                  <span aria-hidden="true" />
                  Ожидаю выбора выделенной карточки
                </div>
              )}
              {currentTutorialStep.id === "upload-file" && !upload && (
                <div className="request-tutorial-wait" role="status">
                  <span aria-hidden="true" />
                  {uploading
                    ? "Файл загружается и проверяется"
                    : "Ожидаю загрузки файла"}
                </div>
              )}
              {tutorialActionPending &&
                !["select-raw", "upload-file"].includes(
                  currentTutorialStep.id,
                ) && (
                  <div className="request-tutorial-wait" role="status">
                    <span aria-hidden="true" />
                    {currentTutorialStep.id === "generate" && isRunning
                      ? "Файл формируется — помощник дождётся результата"
                      : "Ожидаю выполнения выделенного действия"}
                  </div>
                )}
              {REQUEST_TUTORIAL_MANUAL_CONFIRMATION_STEPS.has(tutorialStepId) &&
                tutorialActionComplete && (
                  <div className="request-tutorial-done" role="status">
                    <span aria-hidden="true">✓</span>
                    Действие выполнено. Проверьте результат в списке и нажмите
                    «Далее».
                  </div>
                )}
            </div>

            <div className="request-tutorial-actions">
              <button
                className="request-tutorial-exit"
                type="button"
                onClick={dismissTutorial}
              >
                Выйти из обучения
              </button>
              <div>
                {currentTutorialStep.id === "complete" ? (
                  <button
                    className="secondary-button compact"
                    type="button"
                    onClick={beginTutorial}
                  >
                    Пройти заново
                  </button>
                ) : (
                  currentTutorialStep.id !== "welcome" && (
                    <button
                      className="secondary-button compact"
                      type="button"
                      onClick={goToPreviousTutorialStep}
                    >
                      Назад
                    </button>
                  )
                )}
                <button
                  className="primary-button compact"
                  type="button"
                  onClick={
                    currentTutorialStep.id === "complete"
                      ? completeTutorial
                      : goToNextTutorialStep
                  }
                  disabled={
                    tutorialActionPending ||
                    (currentTutorialStep.id === "send-to-master" &&
                      !!user?.canAccessMaster)
                  }
                >
                  {currentTutorialStep.id === "welcome"
                    ? "Начать обучение"
                    : currentTutorialStep.id === "complete"
                      ? "Готово"
                      : tutorialActionPending
                        ? tutorialPendingButtonLabel
                        : "Далее"}
                </button>
              </div>
            </div>
          </aside>
        </div>
      )}

      <div className="workspace">
        <section className="content-panel">
          <div className="content-heading">
            <div>
              <p className="eyebrow">Шаг {step} из 3</p>
              <h2>
                {isComplete
                  ? "Результат готов"
                  : upload
                    ? "Настройте обработку"
                    : startVariant === "raw"
                      ? "Загрузите файл"
                      : startVariant === "formatted"
                        ? "Загрузите готовый файл"
                        : "Выберите вариант работы"}
              </h2>
            </div>
            {upload && (
              <button className="text-button" type="button" onClick={resetAll}>
                Начать заново
              </button>
            )}
          </div>

          <section
            className={`card collapsible-card ${
              collapsedSections.upload ? "is-collapsed" : ""
            }`}
            aria-labelledby="upload-title"
            data-tour="upload-section"
          >
            <div className="section-heading">
              <div>
                <span className="section-index">01</span>
                <div>
                  <h3 id="upload-title">
                    {startVariant
                      ? startVariant === "raw"
                        ? "Сырой файл с опорными номерами и АОН"
                        : "Готовый сформированный файл"
                      : "Какой файл вы хотите обработать?"}
                  </h3>
                  <p>
                    {startVariant === "raw"
                      ? "Одна или две колонки: опорный номер и АОН либо только опорный номер."
                      : startVariant === "formatted"
                        ? "Одна колонка, где каждая строка уже содержит опорный номер и его АОН."
                        : "Сначала выберите структуру файла — интерфейс настроится под неё."}
                  </p>
                </div>
              </div>
              <div className="section-heading-actions">
                {upload ? (
                  <span className="status-badge success">Загружен</span>
                ) : (
                  startVariant && (
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => {
                        setStartVariant(null);
                        setMode("auto");
                        setError("");
                        setNotice("");
                      }}
                    >
                      Сменить вариант
                    </button>
                  )
                )}
                <button
                  className="section-collapse-button"
                  type="button"
                  onClick={() => toggleSection("upload")}
                  aria-expanded={!collapsedSections.upload}
                >
                  <span>
                    {collapsedSections.upload ? "Развернуть" : "Свернуть"}
                  </span>
                  <span aria-hidden="true">⌄</span>
                </button>
              </div>
            </div>
            {!startVariant ? (
              <div
                className="start-variant-grid"
                role="group"
                aria-label="Вариант исходного файла"
              >
                <button
                  className="start-variant-card"
                  type="button"
                  data-tour="raw-variant"
                  onClick={() => {
                    setStartVariant("raw");
                    setMode("raw");
                    setError("");
                    setNotice("");
                  }}
                >
                  <span className="start-variant-number">Вариант 1</span>
                  <strong>Обработка заявки на добавление номеров</strong>
                  <span>
                    Подходит для обработки сырых файлов по входящим заявкам на
                    создание новых связок номеров с необходимыми параметрами,
                    где может быть столбец с опорными номерами и столбец с АОН
                    номерами, которые нужно привязать к опорным, с настройкой
                    для дальнейшей загрузки в мастер файл.
                  </span>
                </button>
                <button
                  className="start-variant-card"
                  type="button"
                  onClick={() => {
                    setStartVariant("formatted");
                    setMode("formatted");
                    setError("");
                    setNotice("");
                  }}
                >
                  <span className="start-variant-number">Вариант 2</span>
                  <strong>Редактировать готовый CSV файл</strong>
                  <span>
                    Подходит для обработки ранее сформированных CSV файлов,
                    когда необходимо удалить ранее созданные связки или внести
                    в них изменения, после чего сгенерированный файл можно
                    подгрузить в мастер файл и обновить эти связки.
                  </span>
                </button>
              </div>
            ) : !upload ? (
              <label
                className={`dropzone ${dragging ? "is-dragging" : ""} ${
                  uploading ? "is-loading" : ""
                }`}
                data-tour="file-dropzone"
                onDragEnter={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={(event) => {
                  event.preventDefault();
                  setDragging(false);
                }}
                onDrop={handleDrop}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.xlsb,.csv"
                  onChange={handleFileChange}
                  disabled={uploading}
                />
                <span className="upload-symbol" aria-hidden="true">
                  ↑
                </span>
                <strong>
                  {uploading
                    ? "Загружаем и проверяем…"
                    : startVariant === "raw"
                      ? "Перетащите файл в эту область"
                      : "Перетащите готовый файл сюда"}
                </strong>
                <span>
                  {uploading
                    ? "Это может занять несколько секунд"
                    : "или выберите на устройстве"}
                </span>
                {!uploading && (
                  <span className="choose-button">Выбрать файл</span>
                )}
                <small>XLSX · XLS · XLSB · CSV</small>
              </label>
            ) : (
              <div className="file-row">
                <span className="file-icon" aria-hidden="true">
                  {upload.format?.slice(0, 3).toUpperCase() || "FILE"}
                </span>
                <span className="file-main">
                  <strong>{upload.name}</strong>
                  <small>
                    {formatBytes(upload.size)} · {upload.format.toUpperCase()}
                  </small>
                </span>
                <span className="file-check" aria-hidden="true">
                  ✓
                </span>
                <button
                  className="secondary-button compact"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || isRunning}
                >
                  Заменить
                </button>
                <input
                  ref={fileInputRef}
                  className="visually-hidden"
                  type="file"
                  accept=".xlsx,.xls,.xlsb,.csv"
                  onChange={handleFileChange}
                />
              </div>
            )}
          </section>

          {error && (
            <div className="alert error-alert" role="alert">
              <span aria-hidden="true">!</span>
              <div>
                <strong>Не получилось продолжить</strong>
                <p>{error}</p>
              </div>
            </div>
          )}
          {notice && !error && (
            <div className="alert notice-alert" role="status">
              <span aria-hidden="true">✓</span>
              <p>{notice}</p>
            </div>
          )}

          {duplicateCount > 0 && (
            <aside
              className="duplicate-sticky-navigator"
              aria-label="Навигация по дубликатам"
            >
              <div aria-live="polite">
                <span>Найдено дубликатов</span>
                <strong>
                  {activeDuplicate
                    ? `${activeDuplicate.index + 1} из ${duplicateFindings.length}`
                    : duplicateCount}
                </strong>
                {activeDuplicate && (
                  <small>
                    {activeDuplicate.finding.kind === "b"
                      ? `АОН ${activeDuplicate.finding.bNumber}`
                      : `Опорный номер ${activeDuplicate.finding.aNumber}`}
                  </small>
                )}
              </div>
              <button
                className="primary-button compact"
                type="button"
                onClick={() => void showNextDuplicate()}
                disabled={duplicateNavigating}
              >
                {duplicateNavigating
                  ? "Показываем…"
                  : "Показать следующий дубликат"}
              </button>
            </aside>
          )}

          {upload && (
            <section
              className={`card collapsible-card ${
                collapsedSections.import ? "is-collapsed" : ""
              }`}
              aria-labelledby="settings-title"
              data-tour="import-parameters"
            >
              <div className="section-heading">
                <div>
                  <span className="section-index section-index-label">
                    Импорт
                  </span>
                  <div>
                    <h3 id="settings-title">Параметры импорта</h3>
                    <p>
                      Настройте чтение файла, затем добавляйте, форматируйте и
                      удаляйте связки в одном месте.
                    </p>
                  </div>
                </div>
                <div className="section-heading-actions">
                  {inspecting && (
                    <span className="status-badge">Анализируем…</span>
                  )}
                  <button
                    className="section-collapse-button"
                    type="button"
                    onClick={() => toggleSection("import")}
                    aria-expanded={!collapsedSections.import}
                  >
                    <span>
                      {collapsedSections.import ? "Развернуть" : "Свернуть"}
                    </span>
                    <span aria-hidden="true">⌄</span>
                  </button>
                </div>
              </div>

              {true && (
                <>
                  <div className="form-grid three-columns">
                    <div className="field">
                      <span>Выбранный вариант</span>
                      <div className="scenario-lock">
                        <strong>
                          {startVariant === "formatted"
                            ? "Готовый файл"
                            : "Сырой файл"}
                        </strong>
                      </div>
                      <small>
                        Режим выбран до загрузки и не меняется автоматически.
                      </small>
                    </div>
                    <label className="field">
                      <span>Лист</span>
                      <select
                        value={sheet}
                        onChange={(event) => {
                          setSheet(event.target.value);
                          setMappingConfirmed(false);
                        }}
                        disabled={!sheets.length}
                      >
                        {!sheets.length && (
                          <option value="">Лист не требуется</option>
                        )}
                        {sheets.map((item) => (
                          <option key={item} value={item}>
                            {item}
                          </option>
                        ))}
                      </select>
                      <small>Выбран по структуре данных</small>
                    </label>
                    <div className="field refresh-field">
                      <span>Применить выбор</span>
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() =>
                          void requestInspection(upload, {
                            sheet: sheet || null,
                            mode,
                          })
                        }
                        disabled={inspecting}
                      >
                        {inspecting ? "Проверяем…" : "Обновить анализ"}
                      </button>
                      <small>Перечитаем только предпросмотр</small>
                    </div>
                  </div>
                  {startVariant === "formatted" ? (
                    <div className="formatted-column-row">
                      <span className="formatted-column-icon" aria-hidden="true">
                        1
                      </span>
                      <div>
                        <strong>Одна колонка с готовыми строками</strong>
                        <small>
                          Опорный номер и его АОН читаются из одной
                          сформированной строки. Формат зафиксирован, первый
                          столбец используется автоматически.
                        </small>
                      </div>
                      <span className="status-badge success">
                        Первый столбец выбран
                      </span>
                    </div>
                  ) : (
                    <div className="mapping-row">
                      <label className="field">
                        <span>Колонка «Опорный номер»</span>
                        <select
                          value={aColumn}
                          onChange={(event) => {
                            setAColumn(Number(event.target.value));
                            setMappingConfirmed(false);
                          }}
                          disabled={!columns.length}
                        >
                          {columns.map((column) => (
                            <option key={column.index} value={column.index}>
                              {column.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <span className="mapping-arrow" aria-hidden="true">
                        →
                      </span>
                      <label className="field">
                        <span>Колонка «АОН»</span>
                        <select
                          value={bColumn}
                          onChange={(event) => {
                            setBColumn(Number(event.target.value));
                            setMappingConfirmed(false);
                          }}
                          disabled={!columns.length || sourceHasOnlyA}
                        >
                          {bColumnOptions.map((column) => (
                            <option key={column.index} value={column.index}>
                              {column.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className={`confirm-button ${mappingConfirmed ? "is-confirmed" : ""}`}
                        type="button"
                        data-tour="import-confirm"
                        onClick={() => {
                          setMappingConfirmed(true);
                          setError("");
                          setNotice("Сопоставление подтверждено.");
                          setCollapsedSections(
                            collapsedSectionState("editor"),
                          );
                        }}
                        disabled={!inspection || inspecting}
                      >
                        {mappingConfirmed
                          ? "✓ Подтверждено"
                          : "Подтвердить колонки"}
                      </button>
                    </div>
                  )}
                  {startVariant === "raw" && sourceHasOnlyA && (
                    <div className="inline-warning a-only-warning" role="status">
                      <span aria-hidden="true">!</span>
                      В файле найдены только опорные номера. Каждый номер
                      отображается в редакторе, даже пока у него нет АОН. Если
                      АОН не добавить, при формировании CSV он будет равен
                      опорному номеру.
                    </div>
                  )}
                  {duplicateCount > 0 && (
                    <div className="duplicate-decision" role="alert">
                      <div>
                        <span className="duplicate-decision-mark">!</span>
                        <div>
                          <strong>
                            Найдены дубликаты: {duplicateCount}
                          </strong>
                          <p>
                            Автоматическое решение не применяется. Выберите,
                            оставить повторяющиеся АОН или удалить повторы с
                            сохранением первого появления.
                          </p>
                        </div>
                      </div>
                      <div className="duplicate-decision-actions">
                        <button
                          className={`secondary-button compact ${
                            duplicateDecision === "keep"
                              ? "is-selected-decision"
                              : ""
                          }`}
                          type="button"
                          onClick={() => setDuplicateDecision("keep")}
                        >
                          Оставить дубликаты
                        </button>
                        <button
                          className={`secondary-button compact ${
                            duplicateDecision === "remove"
                              ? "is-selected-decision"
                              : ""
                          }`}
                          type="button"
                          onClick={() => setDuplicateDecision("remove")}
                        >
                          Удалить дубликаты
                        </button>
                      </div>
                    </div>
                  )}
                  {false && (
                    <div className="mapping-format-editor">
                      <div className="manual-mapping-heading">
                        <div>
                          <span>Индивидуальные строки</span>
                          <strong>
                            Выберите опорный номер и задайте формат его связки
                          </strong>
                          <small>
                            Поиск работает по опорному номеру, PANI и АОН.
                            Ненастроенные опорные номера получат общий формат.
                          </small>
                        </div>
                        <div className="selection-counter" aria-live="polite">
                          <strong>{mappingFormats.length}</strong>
                          <span>индивидуальных форматов</span>
                        </div>
                      </div>

                      {mappingFormats.length > 0 && (
                        <div
                          className="mapping-format-list"
                          aria-label="Настроенные форматы опорных номеров"
                        >
                          {mappingFormats.map((selection) => {
                            const formatError =
                              mappingFormatError(selection);
                            return (
                              <article
                                className="mapping-format-card"
                                key={selection.aNumber}
                              >
                                <div className="manual-mapping-a">
                                  <span>Опорный номер</span>
                                  <strong>{selection.aNumber}</strong>
                                  <button
                                    className="danger-text-button"
                                    type="button"
                                    onClick={() =>
                                      toggleMappingFormat(selection)
                                    }
                                  >
                                    Убрать настройку
                                  </button>
                                </div>
                                <div className="mapping-format-controls">
                                  <label className="field">
                                    <span>Вид строки</span>
                                    <select
                                      value={selection.kind}
                                      onChange={(event) =>
                                        updateMappingFormat(
                                          selection.aNumber,
                                          {
                                            kind: event.target
                                              .value as MappingFormatKind,
                                            value: "",
                                          },
                                        )
                                      }
                                    >
                                      <option value="default">
                                        По умолчанию
                                      </option>
                                      <option value="linked-a">
                                        Опорный с PANI
                                      </option>
                                      <option value="region">
                                        С кодом региона
                                      </option>
                                      <option value="pani-region">
                                        PANI + код региона
                                      </option>
                                      <option value="custom">
                                        Свой параметр
                                      </option>
                                    </select>
                                  </label>
                                  {selection.kind !== "default" && (
                                    <label className="field">
                                      <span>
                                        {selection.kind === "linked-a"
                                          ? "Номер PANI"
                                          : selection.kind === "region"
                                            ? "Код региона"
                                            : "Введите свой параметр"}
                                      </span>
                                      <input
                                        value={selection.value}
                                        onChange={(event) =>
                                          updateMappingFormat(
                                            selection.aNumber,
                                            {
                                              value:
                                                selection.kind === "linked-a"
                                                  ? paniInputValue(
                                                      event.target.value,
                                                    )
                                                  : event.target.value,
                                            },
                                          )
                                        }
                                        placeholder={
                                          selection.kind === "linked-a"
                                            ? "79947013851"
                                            : selection.kind === "region"
                                              ? "D77"
                                              : "79947013851& null/$ & null/$ &"
                                        }
                                        maxLength={
                                          selection.kind === "linked-a"
                                            ? 11
                                            : selection.kind === "custom"
                                              ? 256
                                              : 32
                                        }
                                        inputMode={
                                          selection.kind === "linked-a"
                                            ? "numeric"
                                            : "text"
                                        }
                                      />
                                      {selection.kind !== "linked-a" && (
                                        <small>
                                          {selection.kind === "custom"
                                            ? "Введите точное начало строки с тремя «&», включая последний."
                                            : "Знак $ добавится автоматически."}
                                        </small>
                                      )}
                                    </label>
                                  )}
                                </div>
                                {formatError && (
                                  <p className="field-error" role="alert">
                                    {formatError}
                                  </p>
                                )}
                                <div className="mapping-format-preview">
                                  <span>Предпросмотр итоговой строки</span>
                                  <code>
                                    {mappingFormatPreview(selection)}
                                  </code>
                                  {selection.bTruncated && (
                                    <small>
                                      Показан фрагмент; в результат попадут все
                                      АОН этой связки.
                                    </small>
                                  )}
                                </div>
                              </article>
                            );
                          })}
                        </div>
                      )}

                      <div className="mapping-picker format-mapping-picker">
                        <div className="mapping-picker-toolbar">
                          <label className="field mapping-search">
                            <span>
                              Найти опорный номер, PANI или АОН для настройки
                            </span>
                            <input
                              type="search"
                              value={mappingQuery}
                              onChange={(event) => {
                                setMappingQuery(event.target.value);
                                setActiveDuplicate(null);
                              }}
                              placeholder="Введите номер"
                              maxLength={256}
                            />
                          </label>
                          <small className="format-search-hint">
                            Выберите опорный номер из исходного файла
                          </small>
                        </div>
                        {mappingsError && (
                          <div className="mapping-picker-message is-error">
                            <strong>Не удалось показать связки</strong>
                            <span>{mappingsError}</span>
                          </div>
                        )}
                        {mappingsLoading && !mappingOptions.length ? (
                          <div
                            className="mapping-picker-message"
                            role="status"
                          >
                            Строим быстрый индекс связок…
                          </div>
                        ) : editorMappings.length ? (
                          <div
                            className="format-search-list"
                            aria-label="Опорные номера для настройки формата"
                          >
                            {editorMappings.map((mapping) => {
                              const selected = mappingFormats.some(
                                (item) =>
                                  item.aNumber === mapping.aNumber,
                              );
                              return (
                                <article
                                  className={`format-search-item ${
                                    selected ? "is-selected" : ""
                                  }`}
                                  key={mapping.aNumber}
                                >
                                  <div>
                                    <span>Опорный номер</span>
                                    <strong>{mapping.aNumber}</strong>
                                    {mapping.linkedANumber && (
                                      <small>
                                        Опорный с PANI:{" "}
                                        <HighlightedNumber
                                          value={mapping.linkedANumber}
                                          query={normalizedMappingQuery}
                                        />
                                      </small>
                                    )}
                                    <small>
                                      АОН:{" "}
                                      {mapping.bNumbers
                                        .slice(0, 3)
                                        .join(", ")}
                                      {(mapping.bTruncated ||
                                        mapping.bNumbers.length > 3) &&
                                        "…"}
                                    </small>
                                  </div>
                                </article>
                              );
                            })}
                          </div>
                        ) : (
                          !mappingsError && (
                            <div className="mapping-picker-message">
                              {mappingQuery
                                ? "По этому номеру связок не найдено."
                                : "В файле нет доступных связок."}
                            </div>
                          )
                        )}
                        <div className="mapping-picker-footer">
                          <small>
                            Показано {editorMappings.length} из{" "}
                            {editorMappingSourceTotal}
                          </small>
                          {mappingOptions.length < mappingTotal && (
                            <button
                              className="secondary-button compact"
                              type="button"
                              onClick={() =>
                                upload &&
                                void loadMappingOptions(
                                  upload,
                                  "",
                                  mappingOptions.length,
                                  true,
                                )
                              }
                              disabled={mappingsLoading}
                            >
                              {mappingsLoading
                                ? "Загружаем…"
                                : "Показать ещё"}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {upload && (
            <section
              className={`card collapsible-card operation-card ${
                collapsedSections.editor ? "is-collapsed" : ""
              }`}
              aria-labelledby="connections-editor-title"
              ref={editorRef}
              data-tour="connections-editor"
            >
              <div className="section-heading">
                <div>
                  <span className="section-index">02</span>
                  <div>
                    <h3 id="connections-editor-title">
                      Редактирование связок
                    </h3>
                    <p>
                      Найдите опорный номер, измените его параметр или состав
                      привязанных АОН.
                    </p>
                  </div>
                </div>
                <button
                  className="section-collapse-button"
                  type="button"
                  onClick={() => toggleSection("editor")}
                  aria-expanded={!collapsedSections.editor}
                >
                  <span>
                    {collapsedSections.editor ? "Развернуть" : "Свернуть"}
                  </span>
                  <span aria-hidden="true">⌄</span>
                </button>
              </div>
                  <div className="mapping-picker">
                    <div className="mapping-picker-toolbar has-parameter-filter">
                      <label
                        className="field mapping-search"
                        data-tour="mapping-search"
                      >
                        <span>Найти опорный номер, PANI или АОН</span>
                        <input
                          ref={mappingSearchInputRef}
                          type="search"
                          value={mappingQuery}
                          onChange={(event) => {
                            setMappingQuery(event.target.value);
                            setActiveDuplicate(null);
                          }}
                          placeholder="Введите номер"
                          maxLength={256}
                        />
                        <small aria-live="polite">
                          {normalizedMappingQuery
                            ? searchMatchedANumbers.length
                              ? hasExactMappingMatches
                                ? `Точно найдено связок: ${searchMatchedANumbers.length}. Лишние значения скрыты.`
                                : `Найдено связок: ${searchMatchedANumbers.length}. Совпадения подняты вверх и раскрыты.`
                              : "Совпадений нет. Исходный список сохранён ниже."
                            : "Начните вводить опорный номер, PANI или АОН — совпадения появятся наверху списка."}
                        </small>
                      </label>
                      <button
                        className={`secondary-button compact mapping-filter-button ${
                          selectedMappingParameterGroups.length
                            ? "is-active-filter"
                            : ""
                        }`}
                        type="button"
                        data-tour="mapping-filter"
                        aria-expanded={mappingFilterOpen}
                        onClick={() =>
                          setMappingFilterOpen((current) => !current)
                        }
                      >
                        Фильтр параметров
                        {selectedMappingParameterGroups.length
                          ? ` · ${selectedMappingParameterGroups.length}`
                          : ""}
                      </button>
                      <div
                        className="selection-counter editor-counter"
                        aria-live="polite"
                      >
                        <span>
                          <strong>{chosenANumbers.length}</strong>
                          опор выбрано
                        </span>
                        <span>
                          <strong>{aNumbers.length}</strong>
                          опор удалить
                        </span>
                        <span>
                          <strong>{selectedBCount}</strong>
                          АОН удалить
                        </span>
                        <span>
                          <strong>{manualAdditions.length}</strong>
                          добавлено
                        </span>
                      </div>
                    </div>

                    {mappingFilterOpen && (
                      <div
                        className="mapping-parameter-filter-panel"
                        data-tour="mapping-filter-options"
                      >
                        <div>
                          <strong>Параметры этого файла</strong>
                          <span>
                            Можно выбрать несколько групп: каждый опорный
                            номер сохраняет свой параметр.
                          </span>
                        </div>
                        <fieldset>
                          <legend>Существующие параметры</legend>
                          {mappingParameterOptions.length ? (
                            mappingParameterOptions.map((parameter) => (
                              <label key={parameter.id}>
                                <input
                                  type="checkbox"
                                  checked={selectedMappingParameterGroups.includes(
                                    parameter.id,
                                  )}
                                  onChange={(event) =>
                                    setSelectedMappingParameterGroups(
                                      (current) =>
                                        event.target.checked
                                          ? [...current, parameter.id]
                                          : current.filter(
                                              (value) =>
                                                value !== parameter.id,
                                            ),
                                    )
                                  }
                                />
                                <span>{parameter.label}</span>
                                <small>{parameter.count}</small>
                              </label>
                            ))
                          ) : (
                            <p>В файле пока нет опорных номеров.</p>
                          )}
                        </fieldset>
                        <button
                          className="text-button"
                          type="button"
                          disabled={!selectedMappingParameterGroups.length}
                          onClick={() => setSelectedMappingParameterGroups([])}
                        >
                          Сбросить фильтр
                        </button>
                      </div>
                    )}

                    <div className="bulk-a-toolbar">
                      <div className="bulk-a-selection">
                        <div>
                          <strong>Действия с выбранными опорными номерами</strong>
                          <small>
                            Выбор сохраняется при поиске и раскрытии других
                            связок.
                          </small>
                        </div>
                      </div>
                      <div className="bulk-a-controls">
                        <button
                          className="secondary-button bulk-select-button"
                          type="button"
                          data-tour="bulk-select-all"
                          onClick={() => void toggleAllMappingChoices()}
                          disabled={
                            !editorMappings.length || selectingAllANumbers
                          }
                        >
                          {selectingAllANumbers
                            ? "Выбираем весь файл…"
                            : editorMappings.length > 0 &&
                          editorMappings.every((item) =>
                            chosenANumbers.includes(item.aNumber),
                          )
                            ? "Снять выделение опорных номеров"
                            : "Отметить все опорные номера"}
                        </button>
                        <button
                          className={
                            chosenANumbers.length > 0 &&
                            chosenANumbers.every((item) =>
                              aNumbers.includes(item),
                            )
                              ? "secondary-button bulk-delete-button"
                              : "danger-button bulk-delete-button"
                          }
                          type="button"
                          data-tour="bulk-delete-selected"
                          onClick={applyBulkADeletion}
                          disabled={!chosenANumbers.length}
                        >
                          {chosenANumbers.length > 0 &&
                          chosenANumbers.every((item) =>
                            aNumbers.includes(item),
                          )
                            ? "Отменить удаление выбранных"
                            : "Удалить выбранные опорные номера"}
                        </button>
                        <label
                          className="field bulk-format-kind"
                          data-tour="bulk-parameter-kind"
                        >
                          <span>Выберите параметр опорного номера</span>
                          <select
                            value={bulkFormatKind}
                            onChange={(event) => {
                              setBulkFormatKind(
                                event.target.value as MappingFormatKind,
                              );
                              setBulkFormatValue("");
                            }}
                          >
                            <option value="default">По умолчанию</option>
                            <option value="linked-a">Опорный с PANI</option>
                            <option value="region">С кодом региона</option>
                            <option value="pani-region">
                              PANI + код региона
                            </option>
                            <option value="custom">Свой параметр</option>
                          </select>
                        </label>
                        <MappingParameterValueFields
                          kind={bulkFormatKind}
                          value={bulkFormatValue}
                          onChange={setBulkFormatValue}
                          className="field bulk-format-value"
                          dataTour="bulk-parameter-value"
                        />
                        <button
                          className="primary-button bulk-apply-button"
                          type="button"
                          data-tour="bulk-parameter-apply"
                          onClick={applyBulkAFormat}
                          disabled={!chosenANumbers.length}
                        >
                          Применить параметр
                        </button>
                      </div>
                    </div>

                    {mappingsError && (
                      <div className="mapping-picker-message is-error">
                        <strong>Не удалось показать связки</strong>
                        <span>{mappingsError}</span>
                      </div>
                    )}

                    {mappingsLoading && !editorMappings.length ? (
                      <div className="mapping-picker-message" role="status">
                        Строим быстрый индекс связок. Для большого файла первый
                        запуск может занять некоторое время…
                      </div>
                    ) : editorMappings.length ? (
                      <div
                        className="mapping-list"
                        aria-label="Связки опорных номеров и АОН"
                        ref={mappingListRef}
                        onScroll={(event) => {
                          const target = event.currentTarget;
                          if (
                            upload &&
                            !mappingsLoading &&
                            mappingOptions.length < mappingTotal &&
                            target.scrollTop + target.clientHeight >=
                              target.scrollHeight - 160
                          )
                            void loadMappingOptions(
                              upload,
                              "",
                              mappingOptions.length,
                              true,
                            );
                        }}
                      >
                        {editorMappings.map((mapping) => {
                          const selected = new Set(
                            selectedBByA[mapping.aNumber] ?? [],
                          );
                          const chosen = chosenANumbers.includes(
                            mapping.aNumber,
                          );
                          const searchMatch = searchMatchedASet.has(
                            mapping.aNumber,
                          );
                          const activeDuplicateInMapping =
                            activeDuplicate?.finding.aNumber ===
                            mapping.aNumber;
                          const activeADuplicate =
                            activeDuplicateInMapping &&
                            activeDuplicate?.finding.kind === "a";
                          const expanded =
                            (!!normalizedMappingQuery && searchMatch) ||
                            expandedANumbers.includes(mapping.aNumber);
                          const aSearchMatch =
                            !!normalizedMappingQuery &&
                            mapping.aNumber.includes(normalizedMappingQuery);
                          const matchedBCount = normalizedMappingQuery
                            ? mapping.bNumbers.filter((item) =>
                                item.includes(normalizedMappingQuery),
                              ).length
                            : 0;
                          const exactAnchorMatch =
                            mapping.aNumber === normalizedMappingQuery ||
                            mapping.linkedANumber === normalizedMappingQuery;
                          const displayedBNumbers =
                            hasExactMappingMatches &&
                            !exactAnchorMatch &&
                            matchedBCount > 0
                              ? mapping.bNumbers.filter(
                                  (item) =>
                                    item === normalizedMappingQuery,
                                )
                              : mapping.bNumbers;
                          const aSelected = aNumbers.includes(
                            mapping.aNumber,
                          );
                          const visibleAllSelected =
                            displayedBNumbers.length > 0 &&
                            displayedBNumbers.every((item) =>
                              selected.has(item),
                            );
                          const allSelected =
                            !mapping.bTruncated && visibleAllSelected;
                          const formatSelection = mappingFormats.find(
                            (item) => item.aNumber === mapping.aNumber,
                          );
                          const currentParameter =
                            mapping.sourcePrefix || NO_REGION_PREFIX;
                          const newParameter = formatSelection
                            ? prefixForMappingFormat(formatSelection)
                            : currentParameter;
                          const parameterChanged =
                            newParameter !== currentParameter;
                          return (
                            <article
                              className={`mapping-item ${
                                aSelected ? "will-remove-a" : ""
                              } ${allSelected && !aSelected ? "will-reset-b" : ""
                              } ${chosen ? "is-chosen-a" : ""} ${
                                searchMatch ? "is-search-result" : ""
                              } ${
                                activeADuplicate
                                  ? "is-active-duplicate-a"
                                  : ""
                              }`}
                              ref={
                                activeADuplicate
                                  ? (node) => {
                                      activeDuplicateTargetRef.current = node;
                                    }
                                  : undefined
                              }
                              aria-current={
                                activeADuplicate ? "true" : undefined
                              }
                              key={mapping.aNumber}
                            >
                              <div className="mapping-a-row">
                                <label
                                  className={`a-number-choice ${
                                    chosen ? "is-selected" : ""
                                  }`}
                                  data-tour={
                                    mapping.aNumber === tutorialPrimaryANumber
                                      ? "tutorial-mapping-choice"
                                      : undefined
                                  }
                                >
                                  <input
                                    type="checkbox"
                                    checked={chosen}
                                    onChange={() =>
                                      toggleAChoice(mapping.aNumber)
                                    }
                                  />
                                  <span
                                    className="a-checkbox"
                                    aria-hidden="true"
                                  >
                                    ✓
                                  </span>
                                  <span className="visually-hidden">
                                    Выбрать опорный номер {mapping.aNumber}
                                  </span>
                                </label>
                                <button
                                  className="mapping-expand-toggle"
                                  type="button"
                                  data-tour={
                                    mapping.aNumber === tutorialPrimaryANumber
                                      ? "tutorial-mapping-expand"
                                      : undefined
                                  }
                                  onClick={() =>
                                    toggleAExpanded(mapping)
                                  }
                                  aria-expanded={expanded}
                                >
                                  <span>
                                    <small>Опорный номер</small>
                                    <strong
                                      className={[
                                        hasNumberWhitespace(mapping.aNumber)
                                          ? "is-invalid-number-whitespace"
                                          : "",
                                        hasInvalidNumberLength(mapping.aNumber)
                                          ? "is-invalid-number"
                                          : "",
                                      ].filter(Boolean).join(" ")}
                                    >
                                      <HighlightedNumber
                                        value={mapping.aNumber}
                                        query={normalizedMappingQuery}
                                      />
                                    </strong>
                                  </span>
                                  <span className="mapping-a-meta">
                                    {mapping.linkedANumber && (
                                      <span className="mapping-linked-a-meta">
                                        Опорный с PANI:{" "}
                                        <HighlightedNumber
                                          value={mapping.linkedANumber}
                                          query={normalizedMappingQuery}
                                        />
                                      </span>
                                    )}
                                    <span>
                                      {mapping.bTotal ??
                                        mapping.bNumbers.length}{" "}
                                      АОН
                                      {matchedBCount > 0 &&
                                        !aSearchMatch &&
                                        ` · найдено АОН: ${matchedBCount}`}
                                      {manualAdditions.some(
                                        (item) =>
                                          item.aNumber === mapping.aNumber,
                                      ) && " · добавлено вручную"}
                                    </span>
                                    <span className="mapping-parameter-meta">
                                      Текущий параметр:{" "}
                                      <code>{currentParameter}</code>
                                    </span>
                                    {parameterChanged && (
                                      <span className="mapping-parameter-meta is-new">
                                        Новый параметр:{" "}
                                        <code>{newParameter}</code>
                                      </span>
                                    )}
                                  </span>
                                  <span className="mapping-a-statuses">
                                    {aSelected && (
                                      <span className="mapping-a-badge danger">
                                        К удалению
                                      </span>
                                    )}
                                    {parameterChanged && (
                                      <span className="mapping-a-badge">
                                        Параметр изменён
                                      </span>
                                    )}
                                    {mapping.linkedANumber &&
                                      !parameterChanged && (
                                        <span className="mapping-a-badge source">
                                          Опорный с PANI
                                        </span>
                                      )}
                                    <span className="mapping-expand-action">
                                      <span>
                                        {expanded ? "Свернуть" : "Раскрыть"}
                                      </span>
                                      <span
                                        className="mapping-chevron"
                                        aria-hidden="true"
                                      >
                                        ⌄
                                      </span>
                                    </span>
                                  </span>
                                </button>
                              </div>
                              {expanded && (
                                <div className="mapping-item-body">
                                  <div className="mapping-item-actions">
                                    <button
                                      className="secondary-button compact"
                                      type="button"
                                      onClick={() =>
                                        toggleAllBForA({
                                          ...mapping,
                                          bNumbers: displayedBNumbers,
                                        })
                                      }
                                      disabled={
                                        aSelected || !displayedBNumbers.length
                                      }
                                    >
                                      {displayedBNumbers.length !==
                                      mapping.bNumbers.length
                                        ? visibleAllSelected
                                          ? "Снять выделение АОН на удаление"
                                          : "Отметить все АОН на удаление"
                                        : allSelected || visibleAllSelected
                                          ? "Снять выделение АОН на удаление"
                                          : "Отметить все АОН на удаление"}
                                    </button>
                                    <button
                                      className={
                                        aSelected
                                          ? "secondary-button compact"
                                          : "danger-button compact"
                                      }
                                      type="button"
                                      onClick={() =>
                                        toggleASelection(mapping.aNumber)
                                      }
                                    >
                                      {aSelected
                                        ? "Вернуть опору"
                                        : "Удалить опорный номер"}
                                    </button>
                                  </div>
                                  <div className="mapping-editor-tools">
                                    <div className="inline-edit-a">
                                      <label className="field">
                                        <span>Исправить опорный номер</span>
                                        <input
                                          className={
                                            hasNumberWhitespace(
                                              aNumberEditValues[
                                                mapping.aNumber
                                              ] ?? mapping.aNumber,
                                            )
                                              ? "is-invalid-number-whitespace"
                                              : ""
                                          }
                                          value={
                                            aNumberEditValues[
                                              mapping.aNumber
                                            ] ?? mapping.aNumber
                                          }
                                          onChange={(event) =>
                                            setANumberEditValues((current) => ({
                                              ...current,
                                              [mapping.aNumber]:
                                                event.target.value,
                                            }))
                                          }
                                          inputMode="numeric"
                                          spellCheck={false}
                                          aria-invalid={
                                            !numberStartsWithSeven(
                                              aNumberEditValues[
                                                mapping.aNumber
                                              ] ?? mapping.aNumber,
                                            ) ||
                                            (aNumberEditValues[
                                              mapping.aNumber
                                            ] ?? mapping.aNumber
                                            ).replace(/^\+/, "").length !== 11
                                          }
                                          disabled={aSelected}
                                        />
                                        {(aNumberEditValues[
                                          mapping.aNumber
                                        ] ?? mapping.aNumber
                                        ).replace(/^\+/, "").length !== 11 && (
                                          <small className="number-length-warning">
                                            Длина опорного номера не 11 символов.
                                            Исправление доступно и не будет
                                            потеряно при формировании CSV.
                                          </small>
                                        )}
                                        {!numberStartsWithSeven(
                                          aNumberEditValues[
                                            mapping.aNumber
                                          ] ?? mapping.aNumber,
                                        ) && (
                                          <small className="number-start-blocking-warning">
                                            Номер должен начинаться с 7.
                                          </small>
                                        )}
                                        {hasNumberWhitespace(
                                          aNumberEditValues[
                                            mapping.aNumber
                                          ] ?? mapping.aNumber,
                                        ) && (
                                          <small className="number-whitespace-blocking-warning">
                                            В опорном номере есть пробелы.
                                            Удалите их перед формированием CSV.
                                          </small>
                                        )}
                                      </label>
                                      <button
                                        className="secondary-button compact"
                                        type="button"
                                        onClick={() =>
                                          void applyANumberEdit(mapping)
                                        }
                                        disabled={
                                          aSelected ||
                                          !(
                                            aNumberEditValues[
                                              mapping.aNumber
                                            ] ?? mapping.aNumber
                                          ).trim()
                                        }
                                      >
                                        Сохранить исправление
                                      </button>
                                    </div>
                                    <div
                                      className="inline-add-b"
                                      data-tour={
                                        mapping.aNumber ===
                                        tutorialPrimaryANumber
                                          ? "tutorial-add-aon"
                                          : undefined
                                      }
                                    >
                                      <label className="field">
                                        <span>
                                          Добавить АОН к опорному номеру{" "}
                                          {mapping.aNumber}
                                        </span>
                                        <AonAdditionTextarea
                                          value={bAdditionsByA[mapping.aNumber] ?? ""}
                                          onChange={(value) =>
                                            setBAdditionsByA((current) => ({
                                              ...current,
                                              [mapping.aNumber]: value,
                                            }))
                                          }
                                          disabled={aSelected}
                                        />
                                        <small>
                                          По одному в строке или через запятую.
                                          Новые АОН объединятся с текущей
                                          связкой.
                                        </small>
                                      </label>
                                      <button
                                        className="primary-button compact"
                                        type="button"
                                        onClick={() =>
                                          addBToMapping(mapping.aNumber)
                                        }
                                        disabled={
                                          aSelected ||
                                          !(
                                            bAdditionsByA[
                                              mapping.aNumber
                                            ] ?? ""
                                          ).trim()
                                        }
                                      >
                                        Добавить АОН
                                      </button>
                                    </div>
                                    {formatSelection && (
                                      <div className="inline-format-editor">
                                        <div className="mapping-format-controls">
                                          <label className="field">
                                            <span>Параметр опорного номера</span>
                                            <select
                                              value={formatSelection.kind}
                                              onChange={(event) =>
                                                updateMappingFormat(
                                                  mapping.aNumber,
                                                  {
                                                    kind: event.target
                                                      .value as MappingFormatKind,
                                                    value: "",
                                                  },
                                                )
                                              }
                                            >
                                              <option value="default">
                                                По умолчанию
                                              </option>
                                              <option value="linked-a">
                                                Опорный с PANI
                                              </option>
                                              <option value="region">
                                                С кодом региона
                                              </option>
                                              <option value="pani-region">
                                                PANI + код региона
                                              </option>
                                              <option value="custom">
                                                Свой параметр
                                              </option>
                                            </select>
                                          </label>
                                          <MappingParameterValueFields
                                            kind={formatSelection.kind}
                                            value={formatSelection.value}
                                            onChange={(value) =>
                                              updateMappingFormat(
                                                mapping.aNumber,
                                                { value },
                                              )
                                            }
                                          />
                                        </div>
                                        {mappingFormatError(
                                          formatSelection,
                                        ) && (
                                          <p
                                            className="field-error"
                                            role="alert"
                                          >
                                            {mappingFormatError(
                                              formatSelection,
                                            )}
                                          </p>
                                        )}
                                        <div className="mapping-format-preview">
                                          <span>Строка в будущем файле</span>
                                          <code>
                                            {mappingFormatPreview({
                                              ...formatSelection,
                                              bNumbers: mapping.bNumbers,
                                            })}
                                          </code>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                  <div className="b-number-grid">
                                    {displayedBNumbers.length ? (
                                      displayedBNumbers.map((bNumber) => {
                                        const checked = selected.has(bNumber);
                                        const activeBDuplicate =
                                          activeDuplicateInMapping &&
                                          activeDuplicate?.finding.kind ===
                                            "b" &&
                                          activeDuplicate?.finding.bNumber ===
                                            bNumber;
                                        return (
                                          <label
                                            className={`b-number-option ${
                                              checked ? "is-selected" : ""
                                            } ${aSelected ? "is-disabled" : ""} ${
                                              normalizedMappingQuery &&
                                              bNumber.includes(
                                                normalizedMappingQuery,
                                              )
                                                ? "is-search-match"
                                                : ""
                                            } ${
                                              activeBDuplicate
                                                ? "is-active-duplicate-b"
                                                : ""
                                            }`}
                                            data-tour={
                                              mapping.aNumber ===
                                                tutorialPrimaryANumber &&
                                              bNumber === tutorialAddedAon
                                                ? "tutorial-added-aon"
                                                : undefined
                                            }
                                            ref={
                                              activeBDuplicate
                                                ? (node) => {
                                                    activeDuplicateTargetRef.current =
                                                      node;
                                                  }
                                                : undefined
                                            }
                                            aria-current={
                                              activeBDuplicate
                                                ? "true"
                                                : undefined
                                            }
                                            key={bNumber}
                                          >
                                            <input
                                              type="checkbox"
                                              checked={checked}
                                              disabled={aSelected}
                                              onChange={() =>
                                                toggleBSelection(
                                                  mapping.aNumber,
                                                  bNumber,
                                                )
                                              }
                                            />
                                            <span
                                              className="b-checkbox"
                                              aria-hidden="true"
                                            >
                                              ✓
                                            </span>
                                            <span>
                                              <small>АОН</small>
                                              <strong
                                                className={[
                                                  hasInvalidNumberLength(bNumber)
                                                    ? "is-invalid-number"
                                                    : "",
                                                  !numberStartsWithSeven(bNumber)
                                                    ? "is-invalid-number-start"
                                                    : "",
                                                  hasNumberWhitespace(bNumber)
                                                    ? "is-invalid-number-whitespace"
                                                    : "",
                                                ]
                                                  .filter(Boolean)
                                                  .join(" ")}
                                              >
                                                <HighlightedNumber
                                                  value={bNumber}
                                                  query={
                                                    normalizedMappingQuery
                                                  }
                                                />
                                              </strong>
                                              {checked && (
                                                <em>Отмечен на удаление</em>
                                              )}
                                              {hasNumberWhitespace(bNumber) && (
                                                <em className="number-whitespace-label">
                                                  Содержит пробелы
                                                </em>
                                              )}
                                            </span>
                                          </label>
                                        );
                                      })
                                    ) : (
                                      <div className="empty-b-state">
                                        <strong>
                                          У этого опорного номера пока нет АОН
                                        </strong>
                                        <span>
                                          Опорный номер сохранён в списке.
                                          Добавьте АОН в форме выше, если
                                          связка нужна.
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                  {mapping.bTruncated && (
                                    <div className="remove-a-note">
                                      Показана часть АОН. Чтобы найти другой
                                      АОН, уточните строку поиска; удаление
                                      опорного номера всё равно затронет связку
                                      целиком.
                                    </div>
                                  )}
                                  {aSelected && (
                                    <div className="remove-a-note">
                                      Опорный номер и все его АОН будут удалены
                                      целиком.
                                    </div>
                                  )}
                                  {!aSelected && allSelected && (
                                    <div className="remove-a-note">
                                      Выбраны все АОН — после удаления связка
                                      не попадёт в итоговый CSV.
                                    </div>
                                  )}
                                </div>
                              )}
                            </article>
                          );
                        })}
                      </div>
                    ) : (
                      !mappingsError && (
                        <div className="mapping-picker-message">
                          {mappingQuery
                            ? "По этому номеру связок не найдено."
                            : "В файле нет доступных связок."}
                        </div>
                      )
                    )}

                    <div className="mapping-picker-footer">
                      <small>
                        Показано {editorMappings.length} из{" "}
                        {editorMappingSourceTotal}
                      </small>
                      {mappingOptions.length < mappingTotal && (
                        <button
                          className="secondary-button compact"
                          type="button"
                          onClick={() =>
                            upload &&
                            void loadMappingOptions(
                              upload,
                              "",
                              mappingOptions.length,
                              true,
                            )
                          }
                          disabled={mappingsLoading}
                        >
                          {mappingsLoading ? "Загружаем…" : "Показать ещё"}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="inline-warning">
                    <span aria-hidden="true">!</span>
                    Отметьте АОН, которые нужно убрать из ротации, или удалите
                    опорный номер целиком. Неотмеченные номера останутся в
                    итоговом файле.
                  </div>
                </section>
              )}

          {upload && (
            <section
              className={`card collapsible-card operation-card ${
                collapsedSections.bulkDeleteB ? "is-collapsed" : ""
              }`}
              aria-labelledby="bulk-delete-b-title"
              data-tour="bulk-delete-b"
            >
              <div className="section-heading">
                <div>
                  <span className="section-index">03</span>
                  <div>
                    <h3 id="bulk-delete-b-title">
                      Пакетное удаление АОН
                    </h3>
                    <p>
                      Укажите АОН, которые нужно найти и удалить во всех связках
                      файла.
                    </p>
                  </div>
                </div>
                <div className="section-heading-actions">
                  <span className="selection-counter">
                    <strong>{bulkDeleteBNumbers.length}</strong>
                    <span>АОН выбрано</span>
                  </span>
                  <button
                    className="section-collapse-button"
                    type="button"
                    onClick={() => toggleSection("bulkDeleteB")}
                    aria-expanded={!collapsedSections.bulkDeleteB}
                  >
                    <span>
                      {collapsedSections.bulkDeleteB
                        ? "Развернуть"
                        : "Свернуть"}
                    </span>
                    <span aria-hidden="true">⌄</span>
                  </button>
                </div>
              </div>
              <div className="bulk-delete-b-content">
                <label className="field">
                  <span>АОН для удаления</span>
                  <textarea
                    value={bulkDeleteBText}
                    onChange={(event) =>
                      setBulkDeleteBText(event.target.value)
                    }
                    placeholder={"79152671935\n79104627540\n79990000000"}
                    rows={6}
                  />
                  <small>
                    По одному в строке либо через запятую или точку с запятой.
                    Повторы автоматически объединяются.
                  </small>
                </label>
                <div className="bulk-delete-b-explanation">
                  <strong>Что произойдёт</strong>
                  <ol>
                    <li>АОН будет найден во всех опорных номерах.</li>
                    <li>Все найденные вхождения АОН будут удалены.</li>
                    <li>
                      Если у опорного номера не останется АОН, связка будет
                      удалена целиком.
                    </li>
                  </ol>
                  <small>
                    Исходный файл не изменяется. Операция применяется только к
                    новому CSV.
                  </small>
                </div>
              </div>
            </section>
          )}

          {upload && (
            <section
              className={`card collapsible-card operation-card ${
                collapsedSections.bulkDeleteA ? "is-collapsed" : ""
              }`}
              aria-labelledby="bulk-delete-a-title"
              data-tour="bulk-delete-a"
            >
              <div className="section-heading">
                <div>
                  <span className="section-index">04</span>
                  <div>
                    <h3 id="bulk-delete-a-title">
                      Пакетное удаление опорных номеров
                    </h3>
                    <p>
                      Каждый указанный опорный номер будет удалён вместе со
                      всеми привязанными АОН.
                    </p>
                  </div>
                </div>
                <div className="section-heading-actions">
                  <span className="selection-counter">
                    <strong>{manualANumbers.length}</strong>
                    <span>номеров выбрано</span>
                  </span>
                  <button
                    className="section-collapse-button"
                    type="button"
                    onClick={() => toggleSection("bulkDeleteA")}
                    aria-expanded={!collapsedSections.bulkDeleteA}
                  >
                    <span>
                      {collapsedSections.bulkDeleteA
                        ? "Развернуть"
                        : "Свернуть"}
                    </span>
                    <span aria-hidden="true">⌄</span>
                  </button>
                </div>
              </div>
              <div className="command-layout manual-delete-content">
                <label className="field">
                  <span>Опорные номера для удаления</span>
                  <textarea
                    value={aNumbersText}
                    onChange={(event) =>
                      updateANumbersForDeletion(event.target.value)
                    }
                    placeholder={"79299994464\n79990000000"}
                    rows={7}
                  />
                  <small>
                    По одному в строке или через запятую. Выбрано уникальных:{" "}
                    {manualANumbers.length}
                  </small>
                </label>
                <div className="command-upload">
                  <span className="command-upload-mark" aria-hidden="true">
                    +
                  </span>
                  <strong>Загрузить список опорных номеров</strong>
                  <p>
                    Номера будут прочитаны из первой непустой колонки файла.
                  </p>
                  {commandUpload ? (
                    <div className="mini-file">
                      <span>{commandUpload.name}</span>
                      <button
                        type="button"
                        onClick={() => setCommandUpload(null)}
                        aria-label="Удалить файл команд"
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => commandInputRef.current?.click()}
                      disabled={commandUploading}
                    >
                      {commandUploading ? "Загружаем…" : "Выбрать файл"}
                    </button>
                  )}
                  <input
                    ref={commandInputRef}
                    className="visually-hidden"
                    type="file"
                    accept=".xlsx,.xls,.xlsb,.csv"
                    onChange={handleCommandFileChange}
                  />
                </div>
              </div>
            </section>
          )}

          {upload && (
            <section
              className={`card collapsible-card operation-card ${
                collapsedSections.batchAdd ? "is-collapsed" : ""
              }`}
              aria-labelledby="batch-add-title"
              data-tour="batch-add"
            >
              <div className="section-heading">
                <div>
                  <span className="section-index">05</span>
                  <div>
                    <h3 id="batch-add-title">
                      Пакетное добавление опорных номеров и АОН
                    </h3>
                    <p>
                      Добавляйте несколько связок одновременно и назначайте им
                      общий параметр.
                    </p>
                  </div>
                </div>
                <div className="section-heading-actions">
                  <span className="selection-counter" aria-live="polite">
                    <strong>{manualAdditions.length}</strong>
                    <span>связок добавлено</span>
                  </span>
                  <button
                    className="section-collapse-button"
                    type="button"
                    onClick={() => toggleSection("batchAdd")}
                    aria-expanded={!collapsedSections.batchAdd}
                  >
                    <span>
                      {collapsedSections.batchAdd
                        ? "Развернуть"
                        : "Свернуть"}
                    </span>
                    <span aria-hidden="true">⌄</span>
                  </button>
                </div>
              </div>
              <div className="batch-add-layout">
                <label className="field batch-add-numbers">
                  <span>Связки для добавления</span>
                  <textarea
                    value={batchManualText}
                    onChange={(event) =>
                      setBatchManualText(event.target.value)
                    }
                    placeholder={
                      "79772773649;79017094611;79017091445\n79990000000"
                    }
                    rows={7}
                  />
                  <small>
                    Одна связка в строке: опорный номер; АОН; АОН. Если АОН не
                    указан, опорный номер станет собственным АОН.
                  </small>
                </label>
                <div className="batch-add-parameter">
                  <label className="field">
                    <span>Параметр для добавляемых номеров</span>
                    <select
                      value={newMappingFormatKind}
                      onChange={(event) => {
                        setNewMappingFormatKind(
                          event.target.value as MappingFormatKind,
                        );
                        setNewMappingFormatValue("");
                      }}
                    >
                      <option value="default">По умолчанию</option>
                      <option value="linked-a">PANI</option>
                      <option value="region">Код региона</option>
                      <option value="pani-region">
                        PANI + код региона
                      </option>
                      <option value="custom">Свой параметр</option>
                    </select>
                  </label>
                  <MappingParameterValueFields
                    kind={newMappingFormatKind}
                    value={newMappingFormatValue}
                    onChange={setNewMappingFormatValue}
                  />
                  <div className="manual-parameter-preview">
                    <span>Параметр опорного номера</span>
                    <code>
                      {prefixForMappingFormat({
                        aNumber: "79000000000",
                        bNumbers: ["79000000000"],
                        kind: newMappingFormatKind,
                        value: newMappingFormatValue,
                      }) || "без параметра"}
                    </code>
                  </div>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={addManualBatch}
                    disabled={!batchManualText.trim()}
                  >
                    Добавить связки
                  </button>
                </div>
              </div>
              {manualAdditions.length > 0 && (
                <div
                  className="manual-mapping-list"
                  aria-label="Новые связки результата"
                >
                  {manualAdditions.map((mapping) => (
                    <article
                      className="manual-mapping-item"
                      key={mapping.aNumber}
                    >
                      <div className="manual-mapping-a">
                        <span>Опорный номер</span>
                        <strong>{mapping.aNumber}</strong>
                        <code>
                          {prefixForMappingFormat(
                            mappingFormats.find(
                              (item) => item.aNumber === mapping.aNumber,
                            ) ?? {
                              ...mapping,
                              kind: "default",
                              value: "",
                            },
                          ) || "без параметра"}
                        </code>
                        <button
                          className="danger-text-button"
                          type="button"
                          onClick={() =>
                            removeManualMapping(mapping.aNumber)
                          }
                        >
                          Отменить добавление
                        </button>
                      </div>
                      <div className="manual-b-list">
                        {mapping.bNumbers.map((bNumber) => (
                          <button
                            className="manual-b-chip"
                            type="button"
                            onClick={() =>
                              removeManualB(mapping.aNumber, bNumber)
                            }
                            aria-label={`Удалить АОН ${bNumber}`}
                            key={bNumber}
                          >
                            <span>{bNumber}</span>
                            <span aria-hidden="true">×</span>
                          </button>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}

          {inspection && (
            <section
              className={`card collapsible-card ${
                collapsedSections.preview ? "is-collapsed" : ""
              }`}
              aria-labelledby="preview-title"
              data-tour="preview"
            >
              <div className="section-heading">
                <div>
                  <span className="section-index">06</span>
                  <div>
                    <h3 id="preview-title">Предпросмотр и проверка</h3>
                    <p>
                      Исходные строки и все изменения, которые попадут в новый
                      файл.
                    </p>
                  </div>
                </div>
                <div className="section-heading-actions">
                  <span className="status-badge success">Проверено</span>
                  <button
                    className="section-collapse-button"
                    type="button"
                    onClick={() => toggleSection("preview")}
                    aria-expanded={!collapsedSections.preview}
                  >
                    <span>
                      {collapsedSections.preview ? "Развернуть" : "Свернуть"}
                    </span>
                    <span aria-hidden="true">⌄</span>
                  </button>
                </div>
              </div>
              {!!numberWhitespaceViolations.length && (
                <div
                  className="blocking-number-warning is-whitespace-warning"
                  id="number-whitespace-errors"
                  role="status"
                >
                  <div>
                    <strong>Подсвечены номера с пробелами</strong>
                    <span>
                      Это предупреждение не блокирует формирование CSV. Найдено: {" "}
                      {numberWhitespaceViolations.length}.
                    </span>
                  </div>
                  <div className="blocking-number-locations">
                    {numberWhitespaceViolations
                      .slice(0, 100)
                      .map((violation, index) => {
                        const source =
                          whitespaceFindings.find(
                            (finding) =>
                              finding.kind === violation.kind &&
                              finding.aNumber === violation.aNumber &&
                              (finding.kind === "a" ||
                                finding.bNumber === violation.number),
                          ) ??
                          whitespaceFindings.find(
                            (finding) =>
                              finding.kind === violation.kind &&
                              (finding.kind === "a"
                                ? finding.aNumber === violation.number
                                : finding.bNumber === violation.number),
                          );
                        return (
                          <code
                            key={`${violation.kind}-${violation.aNumber}-${violation.number}-${index}`}
                          >
                            {violation.kind === "a"
                              ? `Опорный номер ${JSON.stringify(violation.number)}`
                              : `АОН ${JSON.stringify(violation.number)} → опорный ${violation.aNumber}`}
                            {source ? ` · строка ${source.sourceRow}` : ""}
                          </code>
                        );
                      })}
                    {numberWhitespaceViolations.length > 100 && (
                      <span>
                        Ещё {numberWhitespaceViolations.length - 100} ошибок
                      </span>
                    )}
                  </div>
                </div>
              )}
              {!!aNumberStartWarnings.length && (
                <div
                  className="blocking-number-warning"
                  id="number-start-errors"
                  role="status"
                >
                  <div>
                    <strong>
                      Подсвечены опорные номера, которые начинаются не с 7
                    </strong>
                    <span>
                      Это предупреждение не блокирует формирование CSV. Найдено: {" "}
                      {aNumberStartWarnings.length}.
                    </span>
                  </div>
                  <div className="blocking-number-locations">
                    {aNumberStartWarnings
                      .slice(0, 100)
                      .map((violation, index) => (
                      <code key={`${violation.kind}-${violation.aNumber}-${violation.number}-${index}`}>
                        Опорный номер {violation.number}
                      </code>
                    ))}
                    {aNumberStartWarnings.length > 100 && (
                      <span>
                        Ещё {aNumberStartWarnings.length - 100} предупреждений
                      </span>
                    )}
                  </div>
                </div>
              )}
              {!!aonNumberStartWarnings.length && (
                <div
                  className="blocking-number-warning"
                  id="aon-start-warnings"
                  role="status"
                >
                  <div>
                    <strong>Подсвечены АОН, которые начинаются не с 7</strong>
                    <span>
                      Это только предупреждение. Формирование CSV разрешено.
                      Найдено: {aonNumberStartWarnings.length}.
                    </span>
                  </div>
                  <div className="blocking-number-locations">
                    {aonNumberStartWarnings
                      .slice(0, 100)
                      .map((violation, index) => (
                        <code key={`${violation.kind}-${violation.aNumber}-${violation.number}-${index}`}>
                          АОН {violation.number} → опорный {violation.aNumber}
                        </code>
                      ))}
                    {aonNumberStartWarnings.length > 100 && (
                      <span>
                        Ещё {aonNumberStartWarnings.length - 100} предупреждений
                      </span>
                    )}
                  </div>
                </div>
              )}
              <div
                className="preview-tab-list"
                role="tablist"
                aria-label="Вариант предпросмотра"
              >
                <button
                  className={previewTab === "source" ? "is-active" : ""}
                  type="button"
                  role="tab"
                  aria-selected={previewTab === "source"}
                  onClick={() => setPreviewTab("source")}
                >
                  <span>Исходный вариант</span>
                  <small>Без применённых изменений</small>
                </button>
                <button
                  className={previewTab === "final" ? "is-active" : ""}
                  type="button"
                  role="tab"
                  aria-selected={previewTab === "final"}
                  onClick={() => setPreviewTab("final")}
                >
                  <span>Итоговый вариант</span>
                  <small>Будущий CSV с изменениями</small>
                </button>
              </div>

              {previewTab === "source" ? (
                <div
                  className="preview-tab-panel"
                  role="tabpanel"
                  aria-label="Исходный вариант без изменений"
                >
                  <div
                    className="metrics-grid"
                    aria-label="Метрики исходного файла"
                  >
                    {METRIC_DEFINITIONS.map((metric) => {
                      const value = metricValue(stats, metric.keys);
                      const isIssue =
                        [
                          "Пустых АОН",
                          "Дубликатов опор",
                          "Дубликатов АОН",
                          "Некорректных",
                          "Пропущено строк",
                        ].includes(metric.label) && Number(value) > 0;
                      return (
                        <div
                          className={`metric ${
                            isIssue ? "has-warning" : ""
                          }`}
                          key={metric.label}
                        >
                          <span>{metric.label}</span>
                          <strong>{formatNumber(value)}</strong>
                        </div>
                      );
                    })}
                  </div>
                  <div
                    className="table-wrap preview-scroll-window"
                    tabIndex={0}
                    aria-label="Исходные строки файла"
                  >
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">Строка</th>
                          {(columns.length
                            ? columns
                            : [{ index: 0, name: "Значение" }]
                          ).map((column) => (
                            <th scope="col" key={column.index}>
                              {column.name}
                              {column.index === aColumn && (
                                <span className="column-tag">Опора</span>
                              )}
                              {column.index === bColumn &&
                                mode !== "formatted" && (
                                  <span className="column-tag muted">
                                    АОН
                                  </span>
                                )}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {visibleSourcePreviewRows.length ? (
                          visibleSourcePreviewRows.map((row, rowIndex) => {
                            const cells = previewCells(
                              row,
                              columns.length
                                ? columns
                                : [{ index: 0, name: "Значение" }],
                            );
                            return (
                              <tr
                                key={`${previewSourceRow(
                                  row,
                                  rowIndex + 1,
                                )}-${rowIndex}`}
                              >
                                <th scope="row">
                                  {previewSourceRow(row, rowIndex + 1)}
                                </th>
                                {cells.map((cell, cellIndex) => (
                                  <td key={cellIndex}>
                                    {cell === null ||
                                    cell === undefined ||
                                    cell === "" ? (
                                      <em>пусто</em>
                                    ) : (
                                      String(cell)
                                    )}
                                  </td>
                                ))}
                              </tr>
                            );
                          })
                        ) : (
                          <tr>
                            <td
                              className="empty-table"
                              colSpan={Math.max(columns.length + 1, 2)}
                            >
                              Предпросмотр недоступен, но можно продолжить
                              обработку.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div
                  className="preview-tab-panel"
                  role="tabpanel"
                  aria-label="Итоговый вариант с изменениями"
                >
                  <div className="final-preview-summary">
                    <div>
                      <span>В итоговом CSV</span>
                      <strong>{finalActiveCount}</strong>
                      <small>активных опорных номеров</small>
                    </div>
                    <div>
                      <span>Изменено</span>
                      <strong>
                        {
                          finalPreviewRows.filter(
                            (row) => row.changed || row.added,
                          ).length
                        }
                      </strong>
                      <small>добавления, удаления и формат</small>
                    </div>
                    <div className={finalRemovedCount ? "has-removals" : ""}>
                      <span>Удалено целиком</span>
                      <strong>{finalRemovedCount}</strong>
                      <small>связок отмечено визуально</small>
                    </div>
                  </div>
                  {visibleFinalPreviewRows.length ? (
                    <div
                      className="final-preview-list preview-scroll-window"
                      aria-label="Строки будущего CSV"
                    >
                      {visibleFinalPreviewRows.map((row) => (
                        <article
                          className={`final-preview-row ${
                            row.removed
                              ? "is-removed"
                              : row.added
                                ? "is-added"
                                : row.changed
                                  ? "is-changed"
                                  : ""
                          } ${
                            !row.removed &&
                            (hasNumberWhitespace(row.aNumber) ||
                              row.bNumbers.some(hasNumberWhitespace))
                              ? "has-invalid-whitespace"
                              : ""
                          } ${
                            !row.removed &&
                            (!numberStartsWithSeven(row.aNumber) ||
                              row.bNumbers.some(
                                (number) => !numberStartsWithSeven(number),
                              ))
                              ? "has-invalid-start"
                              : ""
                          }`}
                          key={row.aNumber}
                        >
                          <span
                            className={`final-preview-status ${
                              row.removed
                                ? "is-removed"
                                : row.added
                                  ? "is-added"
                                  : row.changed
                                    ? "is-changed"
                                    : ""
                            }`}
                          >
                            {row.removed
                              ? "Удалено"
                              : row.added
                                ? "Добавлено"
                                : row.changed
                                  ? "Изменено"
                                  : "Без изменений"}
                          </span>
                          <div>
                            <strong>
                              Опорный номер {row.aNumber}
                              {row.linkedANumber
                                ? ` · PANI ${row.linkedANumber}`
                                : ""}
                            </strong>
                            {!row.removed &&
                              hasNumberWhitespace(row.aNumber) && (
                                <span className="blocking-number-inline is-whitespace">
                                  В опорном номере есть пробелы
                                </span>
                              )}
                            {!row.removed &&
                              row.bNumbers.some(hasNumberWhitespace) && (
                                <span className="blocking-number-inline is-whitespace">
                                  АОН с пробелами: {row.bNumbers
                                    .filter(hasNumberWhitespace)
                                    .map((number) => JSON.stringify(number))
                                    .join(", ")}
                                </span>
                              )}
                            {!row.removed &&
                              !numberStartsWithSeven(row.aNumber) && (
                                <span className="blocking-number-inline">
                                  Опорный номер должен начинаться с 7
                                </span>
                              )}
                            {!row.removed &&
                              row.bNumbers.some(
                                (number) => !numberStartsWithSeven(number),
                              ) && (
                                <span className="blocking-number-inline">
                                  АОН не с 7: {row.bNumbers
                                    .filter(
                                      (number) =>
                                        !numberStartsWithSeven(number),
                                    )
                                    .join(", ")}
                                </span>
                              )}
                            <small>
                              {row.removed
                                ? "Связка не попадёт в итоговый CSV"
                                : `${row.bNumbers.length} АОН в итоговой строке`}
                              {row.removedBNumbers.length
                                ? ` · удалено АОН: ${row.removedBNumbers.length}`
                                : ""}
                              {row.truncated
                                ? " · показана доступная часть АОН"
                                : ""}
                            </small>
                            <code>{row.line}</code>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="preview-empty-state">
                      Итоговые строки появятся после загрузки и проверки
                      связок.
                    </div>
                  )}
                </div>
              )}
              {false && (
              <div hidden>
              <div className="change-preview" aria-label="Проверка изменений">
                <div className="change-preview-heading">
                  <div>
                    <span>Будущий результат</span>
                    <strong>Изменения до формирования файла</strong>
                  </div>
                  <small>
                    Добавлено опор: {manualAdditions.length} · удалить опор:{" "}
                    {aNumbers.length} · удалить АОН: {selectedBCount}
                    {startVariant === "formatted"
                      ? ` · пакетно АОН: ${bulkDeleteBNumbers.length}`
                      : ""}
                  </small>
                </div>
                {manualAdditions.length ||
                aNumbers.length ||
                selectedBCount ||
                bulkDeleteBNumbers.length ? (
                  <div className="change-preview-list">
                    {manualAdditions.slice(0, 6).map((mapping) => {
                      const selection = mappingFormats.find(
                        (item) => item.aNumber === mapping.aNumber,
                      ) ?? {
                        ...mapping,
                        kind: "default" as MappingFormatKind,
                        value: "",
                      };
                      return (
                        <div className="change-preview-row" key={mapping.aNumber}>
                          <span className="change-type is-add">Добавлено</span>
                          <code>
                            {mappingFormatPreview({
                              ...selection,
                              bNumbers: mapping.bNumbers,
                            })}
                          </code>
                        </div>
                      );
                    })}
                    {aNumbers.slice(0, 6).map((aNumber) => (
                      <div className="change-preview-row" key={`a-${aNumber}`}>
                        <span className="change-type is-remove">
                          Удалить опору
                        </span>
                        <code>{aNumber} и все его АОН</code>
                      </div>
                    ))}
                    {bCommands.slice(0, 6).map((command) => (
                      <div
                        className="change-preview-row"
                        key={`b-${command.aNumber}`}
                      >
                        <span className="change-type is-remove">
                          Удалить АОН
                        </span>
                        <code>
                          Опора {command.aNumber}:{" "}
                          {command.bNumbers.join(", ")}
                        </code>
                      </div>
                    ))}
                    {bulkDeleteBNumbers.slice(0, 6).map((bNumber) => (
                      <div
                        className="change-preview-row"
                        key={`global-b-${bNumber}`}
                      >
                        <span className="change-type is-remove">
                          Удалить АОН везде
                        </span>
                        <code>{bNumber} во всех найденных связках</code>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="change-preview-empty">
                    Пока без ручных изменений — файл будет только преобразован.
                  </p>
                )}
              </div>
              {manualAdditions.length > 0 && (
                <div
                  className="manual-preview"
                  aria-label="Добавленные вручную связки в предпросмотре"
                >
                  <div className="manual-preview-heading">
                    <div>
                      <span>Добавлено вручную</span>
                      <strong>Связки, которые войдут в итоговый файл</strong>
                    </div>
                    <small>{manualAdditions.length} связок</small>
                  </div>
                  <div className="manual-preview-list">
                    {manualAdditions.map((mapping) => {
                      const format = mappingFormats.find(
                        (item) => item.aNumber === mapping.aNumber,
                      );
                      return (
                        <article
                          className="manual-preview-row"
                          key={`preview-${mapping.aNumber}`}
                        >
                          <div>
                            <span>Опорный номер</span>
                            <strong>{mapping.aNumber}</strong>
                          </div>
                          <div>
                            <span>АОН</span>
                            <strong>{mapping.bNumbers.join(", ")}</strong>
                          </div>
                          <small>
                            {format?.kind === "linked-a"
                              ? "Опорный с PANI"
                              : format?.kind === "region"
                                ? "С кодом региона"
                                : format?.kind === "pani-region"
                                  ? "PANI + код региона"
                                : format?.kind === "custom"
                                  ? "Свой параметр"
                                  : "По умолчанию"}
                          </small>
                        </article>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="metrics-grid" aria-label="Метрики проверки">
                {METRIC_DEFINITIONS.map((metric) => {
                  const value = metricValue(stats, metric.keys);
                  const isIssue =
                    [
                      "Пустых АОН",
                      "Дубликатов опор",
                      "Дубликатов АОН",
                      "Некорректных",
                      "Пропущено строк",
                    ].includes(metric.label) && Number(value) > 0;
                  return (
                    <div
                      className={`metric ${isIssue ? "has-warning" : ""}`}
                      key={metric.label}
                    >
                      <span>{metric.label}</span>
                      <strong>{formatNumber(value)}</strong>
                    </div>
                  );
                })}
              </div>
              <div
                className="table-wrap"
                tabIndex={0}
                aria-label="Предпросмотр файла"
              >
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Строка</th>
                      {(columns.length
                        ? columns
                        : [{ index: 0, name: "Значение" }]
                      ).map((column) => (
                        <th scope="col" key={column.index}>
                          {column.name}
                          {column.index === aColumn && (
                            <span className="column-tag">Опора</span>
                          )}
                          {column.index === bColumn &&
                            mode !== "formatted" && (
                              <span className="column-tag muted">АОН</span>
                            )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.length ? (
                      previewRows.map((row, rowIndex) => {
                        const cells = previewCells(
                          row,
                          columns.length
                            ? columns
                            : [{ index: 0, name: "Значение" }],
                        );
                        return (
                          <tr key={`${previewSourceRow(row, rowIndex + 1)}-${rowIndex}`}>
                            <th scope="row">
                              {previewSourceRow(row, rowIndex + 1)}
                            </th>
                            {cells.map((cell, cellIndex) => (
                              <td key={cellIndex}>
                                {cell === null ||
                                cell === undefined ||
                                cell === "" ? (
                                  <em>пусто</em>
                                ) : (
                                  String(cell)
                                )}
                              </td>
                            ))}
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td
                          className="empty-table"
                          colSpan={Math.max(columns.length + 1, 2)}
                        >
                          Предпросмотр недоступен, но можно продолжить обработку.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              </div>
              )}
            </section>
          )}

          {upload && (
            <section
              className="card csv-settings-card"
              aria-labelledby="csv-title"
              data-tour="csv-settings"
            >
              <details className="settings-details">
                <summary>
                  <span>
                    <span>
                      <strong id="csv-title">Настройки CSV</strong>
                      <small>
                        UTF-8 · {csv.bom ? "с BOM" : "без BOM"} ·{" "}
                        {csv.lineEnding} · разделитель «
                        {csv.delimiter === "\t" ? "Tab" : csv.delimiter}»
                      </small>
                    </span>
                  </span>
                  <span className="summary-chevron" aria-hidden="true">
                    ⌄
                  </span>
                </summary>
                <div className="details-content">
                  <div className="form-grid four-columns">
                    <label className="field">
                      <span>Кодировка</span>
                      <select value="utf-8" disabled>
                        <option>UTF-8</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>Маркер BOM</span>
                      <select
                        value={csv.bom ? "yes" : "no"}
                        onChange={(event) =>
                          setCsv((current) => ({
                            ...current,
                            bom: event.target.value === "yes",
                          }))
                        }
                      >
                        <option value="no">Без BOM</option>
                        <option value="yes">С BOM</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>Конец строки</span>
                      <select
                        value={csv.lineEnding}
                        onChange={(event) =>
                          setCsv((current) => ({
                            ...current,
                            lineEnding: event.target.value as "LF" | "CRLF",
                          }))
                        }
                      >
                        <option value="CRLF">CRLF — Windows</option>
                        <option value="LF">LF — Unix</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>Разделитель</span>
                      <select
                        value={csv.delimiter}
                        onChange={(event) =>
                          setCsv((current) => ({
                            ...current,
                            delimiter: event.target.value,
                          }))
                        }
                      >
                        <option value=",">Запятая</option>
                        <option value=";">Точка с запятой</option>
                        <option value={"\t"}>Табуляция</option>
                        <option value="|">Вертикальная черта</option>
                      </select>
                    </label>
                  </div>
                  <details className="template-details">
                    <summary>Формат строки и код региона</summary>
                    <div className="form-grid template-grid">
                      <label className="field wide">
                        <span>Код региона</span>
                        <input
                          value={template.regionCode}
                          onChange={(event) =>
                            setTemplate((current) => ({
                              ...current,
                              regionCode: regionNumberInputValue(
                                event.target.value,
                              ),
                            }))
                          }
                          placeholder="Необязательно, например 29"
                          maxLength={2}
                          inputMode="numeric"
                        />
                        <small>
                          Число от 1 до 84. Пустое поле: null/$ &amp; null/$ &amp;
                          null/$ &amp;
                        </small>
                      </label>
                      <label className="field">
                        <span>Первый АОН</span>
                        <input
                          value={template.firstBMarker}
                          onChange={(event) =>
                            setTemplate((current) => ({
                              ...current,
                              firstBMarker: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label className="field">
                        <span>Следующие АОН</span>
                        <input
                          value={template.nextBMarker}
                          onChange={(event) =>
                            setTemplate((current) => ({
                              ...current,
                              nextBMarker: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label className="field">
                        <span>Вес</span>
                        <input
                          value={template.weight}
                          onChange={(event) =>
                            setTemplate((current) => ({
                              ...current,
                              weight: event.target.value,
                            }))
                          }
                        />
                      </label>
                    </div>
                  </details>
                </div>
              </details>
            </section>
          )}

          {job && (
            <section
              className={`card job-card ${isComplete ? "is-complete" : ""}`}
              aria-labelledby="job-title"
              aria-live="polite"
            >
              {isComplete ? (
                <>
                  <div className="result-heading">
                    <span className="result-check" aria-hidden="true">
                      ✓
                    </span>
                    <div>
                      <p className="eyebrow">Обработка завершена</p>
                      <h3 id="job-title">Файл готов к скачиванию</h3>
                      <p>Оригинал сохранён без изменений.</p>
                    </div>
                  </div>
                  <div className="summary-grid">
                    {summaryEntries.length ? (
                      summaryEntries.map(([key, value]) => (
                        <div className="summary-item" key={key}>
                          <span>{SUMMARY_LABELS[key] ?? key}</span>
                          <strong>
                            {/size/i.test(key) && typeof value === "number"
                              ? formatBytes(value)
                              : formatNumber(value)}
                          </strong>
                        </div>
                      ))
                    ) : (
                      <div className="summary-item">
                        <span>Статус</span>
                        <strong>Успешно</strong>
                      </div>
                    )}
                  </div>
                  <div className="result-actions">
                    <button
                      ref={downloadButtonRef}
                      className="primary-button"
                      type="button"
                      data-tour="download-result"
                      onClick={() =>
                        void downloadEndpoint("download", "result.csv")
                      }
                      disabled={!!downloading}
                    >
                      <span aria-hidden="true">↓</span>
                      {downloading === "download"
                        ? "Скачиваем…"
                        : "Скачать CSV"}
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() =>
                        void downloadEndpoint("preview", "preview.csv")
                      }
                      disabled={!!downloading}
                    >
                      {downloading === "preview"
                        ? "Открываем…"
                        : "Предпросмотр результата"}
                    </button>
                    <button
                      className="mail-button"
                      type="button"
                      onClick={() => void prepareEmail()}
                      disabled={emailing || !!downloading}
                    >
                      <span aria-hidden="true">✉</span>
                      {emailing ? "Готовим письмо…" : "Отправить по почте"}
                    </button>
                  </div>
                  <div className="result-next-actions">
                    <div>
                      <strong>Нужно что-то поправить?</strong>
                      <small>
                        Текущий файл и все выбранные изменения останутся в
                        редакторе.
                      </small>
                    </div>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={continueEditing}
                    >
                      Продолжить редактирование
                    </button>
                    <button
                      className="text-button"
                      type="button"
                      onClick={resetAll}
                    >
                      Начать с другого файла
                    </button>
                  </div>
                  <div
                    className="result-master-offer"
                    data-tour="send-to-master"
                  >
                    <div>
                      <strong>Обновить мастер файл</strong>
                      <small>
                        Сформированный CSV можно сразу проверить на конфликты и
                        предложить к слиянию.
                      </small>
                    </div>
                    {user?.canAccessMaster ? (
                      <button
                        className="primary-button"
                        type="button"
                        onClick={() => void sendToMaster()}
                        disabled={!!downloading}
                      >
                        {downloading === "master"
                          ? "Готовим предложение…"
                          : "Подгрузить в мастер файл"}
                      </button>
                    ) : (
                      <span>
                        Попросите суперюзера выдать доступ к мастер-файлу.
                      </span>
                    )}
                  </div>
                  {resultPreview && (
                    <div className="result-preview">
                      <div>
                        <strong>Фрагмент результата</strong>
                        <button
                          type="button"
                          onClick={() => setResultPreview("")}
                          aria-label="Закрыть предпросмотр"
                        >
                          ×
                        </button>
                      </div>
                      <pre>{resultPreview}</pre>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="job-topline">
                    <div>
                      <p className="eyebrow">Фоновое задание</p>
                      <h3 id="job-title">{STATUS_LABELS[job.status]}</h3>
                      <p>{job.stage || "Подготавливаем данные…"}</p>
                    </div>
                    <strong className="progress-value">
                      {Math.max(
                        0,
                        Math.min(100, Math.round(job.progress ?? 0)),
                      )}
                      %
                    </strong>
                  </div>
                  <div
                    className="progress-track"
                    role="progressbar"
                    aria-label="Прогресс обработки"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(job.progress ?? 0)}
                  >
                    <span style={{ width: `${job.progress ?? 0}%` }} />
                  </div>
                  <div className="job-meta">
                    <span>
                      Обработано {formatNumber(job.processedRows)}
                      {typeof job.totalRows === "number" && job.totalRows > 0
                        ? ` из ${formatNumber(job.totalRows)}`
                        : ""}{" "}
                      строк
                    </span>
                    {isRunning && (
                      <button
                        className="danger-text-button"
                        type="button"
                        onClick={() => void cancelJob()}
                        disabled={cancelling}
                      >
                        {cancelling ? "Отменяем…" : "Отменить"}
                      </button>
                    )}
                  </div>
                </>
              )}
            </section>
          )}

          {upload && !isComplete && !isRunning && (
            <div className="submit-bar" data-tour="generate">
              <div>
                <strong>
                  Готово: добавить опору — {manualAdditions.length}, удалить
                  опору —{" "}
                  {aNumbers.length}
                  {commandUpload ? " + список" : ""}, удалить АОН —{" "}
                  {selectedBCount}
                  {bulkDeleteBNumbers.length > 0
                    ? ` + пакетно ${bulkDeleteBNumbers.length}`
                    : ""}
                </strong>
                <small>
                  {aNumberStartWarnings.length
                    ? `Подсвечено опорных номеров не с 7: ${aNumberStartWarnings.length}. Формирование разрешено.`
                    : numberWhitespaceViolations.length
                      ? `Подсвечено номеров с пробелами: ${numberWhitespaceViolations.length}. Формирование разрешено.`
                    : aonNumberStartWarnings.length
                      ? `Подсвечено АОН не с 7: ${aonNumberStartWarnings.length}. Формирование разрешено.`
                    : "Обработка выполняется в фоне. Эту страницу можно оставить открытой."}
                </small>
              </div>
              <button
                className="primary-button"
                type="button"
                onClick={() => void startJob()}
                disabled={
                  jobStarting ||
                  inspecting ||
                  !mappingConfirmed
                }
              >
                {jobStarting
                  ? "Создаём задание…"
                  : "Сформировать новый CSV"}
                {!jobStarting && <span aria-hidden="true">→</span>}
              </button>
            </div>
          )}
        </section>
      </div>
      <footer>
        <span>Агент мобильной карусели</span>
        <span>Исходные файлы никогда не изменяются</span>
      </footer>
    </main>
  );
}
