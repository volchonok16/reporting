"use client";

import { useSearchParams } from "next/navigation";
import {
  ChangeEvent,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppHeader } from "../app-header";
import { useAuth } from "../auth-provider";
import { appHref } from "../paths";

const RECORD_PAGE_SIZES = [10, 25, 50, 100, 200] as const;
type RecordPageSize = (typeof RECORD_PAGE_SIZES)[number];
const DEFAULT_RECORD_PAGE_SIZE: RecordPageSize = 10;

type MasterRecord = {
  id: string;
  lineNumber: number;
  aNumber: string;
  bNumbers: string[];
  sourcePrefix: string;
  comment: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  createdRevision: number;
  updatedRevision: number;
  isDuplicate?: boolean;
  isExactDuplicate?: boolean;
  isExactDuplicateExtra?: boolean;
  logicalRow?: string;
  duplicateSourceRows?: number[];
  duplicateSourceFile?: string;
};

type RecordSnapshot = {
  id: string;
  aNumber: string;
  bNumbers: string[];
  sourcePrefix: string;
  comment: string;
  version: number;
};

type ImportRecord = {
  aNumber: string;
  bNumbers: string[];
  sourcePrefix: string;
};

type HistoryItem = {
  id: string;
  revision: number;
  sequence: number;
  recordId: string;
  action: "added" | "updated" | "deleted" | "restored" | "cleared";
  lineNumber: number | null;
  before: RecordSnapshot | null;
  after: RecordSnapshot | null;
  removedBNumbers: string[];
  addedBNumbers: string[];
  sourceFile: string | null;
  sourceRow: number | null;
  actor: string;
  createdAt: number;
};

type ImportItem = {
  id: string;
  status: "new" | "conflict" | "unchanged";
  sourceRow: number;
  aNumber: string;
  incoming: ImportRecord;
  current: RecordSnapshot | null;
};

type ImportMergeResult = {
  revision: number;
  added: number;
  updated: number;
  keptConflicts: number;
  mergedDuplicates: number;
  separateDuplicateRows: number;
};

type ImportAnalysis = {
  importId: string;
  status: "analyzed" | "merged";
  progressRows: number;
  progressPhase: string;
  maxRows: number;
  baseRevision: number;
  sourceName: string;
  mode: "raw" | "formatted";
  errorCode?: string;
  errorMessage?: string;
  mergeResult?: ImportMergeResult;
  stats: {
    new: number;
    unchanged: number;
    conflict: number;
    sourceRows: number;
    uniqueA: number;
    preservedRows?: number;
    totalB: number;
    skippedRows: number;
    invalidRows: number;
    invalidStartRows: number;
    invalidStartNumbers: number;
    duplicateA: number;
    duplicateGroups: number;
    masterOnly: number;
    previewTruncated?: boolean;
  };
  items: ImportItem[];
  duplicates: Array<{
    aNumber: string;
    sourceRows: number[];
  }>;
  numberStartErrors: Array<{
    itemId: string;
    sourceRow: number;
    kind: "a" | "b";
    number: string;
    aNumber: string;
    status: "new" | "conflict" | "unchanged";
  }>;
};

type ImportTask = {
  importId: string;
  status: "queued" | "analyzing" | "merging" | "failed" | "analyzed" | "merged";
  sourceName: string;
  mode: "auto" | "raw" | "formatted";
  baseRevision: number;
  progressRows: number;
  progressPhase: string;
  maxRows: number;
  errorCode?: string;
  errorMessage?: string;
  mergeResult?: ImportMergeResult;
};

type ParameterOption = {
  id: string;
  label: string;
  count: number;
};

type RegionOption = {
  value: number;
  count: number;
};

type MasterLockState = {
  locked: boolean;
  ownedByCurrentUser: boolean;
  ownedByCurrentSession: boolean;
  owner: {
    id: string;
    email: string;
  } | null;
  acquiredAt: number | null;
  notification: {
    id: string;
    kind: "reminder" | "upload_attempt";
    requester: { id: string; email: string };
    createdAt: number;
  } | null;
};

type View = "records" | "history";
type MasterTutorialStep =
  | "welcome"
  | "lock"
  | "stats"
  | "file-actions"
  | "merge"
  | "search"
  | "advanced-search"
  | "filter"
  | "quality"
  | "records"
  | "add-edit"
  | "bulk-delete-a"
  | "bulk-delete-b"
  | "scoped-delete"
  | "history"
  | "history-dates"
  | "complete";
type MasterTutorialStepDefinition = {
  id: MasterTutorialStep;
  title: string;
  description: string;
  action: string;
  target?: string;
  requiresAction?: boolean;
};

const MASTER_TUTORIAL_STEPS: MasterTutorialStepDefinition[] = [
  {
    id: "welcome",
    title: "Добро пожаловать в мастер-файл",
    description:
      "Помощник покажет блокировку, загрузку и слияние файлов, поиск, фильтры, редактирование строк, пакетные операции и историю версий.",
    action:
      "Обучение работает прямо в интерфейсе. Его можно закрыть, снова открыть кнопкой «Обучение» и пройти повторно.",
  },
  {
    id: "lock",
    title: "Займите мастер-файл",
    description:
      "Одновременно изменять базу может только один пользователь. Пока файл занят вами, остальные пользователи видят данные без возможности изменения.",
    action:
      "Если мастер-файл свободен, нажмите «Занять мастер-файл». Если он занят другим пользователем, здесь можно отправить владельцу напоминание.",
    target: '[data-tour="master-lock-panel"]',
    requiresAction: true,
  },
  {
    id: "stats",
    title: "Проверьте состояние базы",
    description:
      "Сводка показывает текущую версию, количество активных строк, АОН и записей в журнале изменений.",
    action:
      "После каждого сохранения или слияния версия увеличивается, а статистика обновляется автоматически.",
    target: '[data-tour="master-stats"]',
  },
  {
    id: "file-actions",
    title: "Загрузка, скачивание и очистка",
    description:
      "Здесь мастер-файл можно скачать, загрузить CSV или Excel для сравнения. Суперюзер может отдельно очистить всю базу или сохранить текущие строки и начать новый журнал с версии T2-0.",
    action:
      "Загруженный файл сначала анализируется. Данные не меняются, пока вы не подтвердите слияние.",
    target: '[data-tour="master-file-actions"]',
  },
  {
    id: "merge",
    title: "Проверьте предложение на слияние",
    description:
      "Предложение разделяет новые строки, совпадения и конфликты. Новые строки можно просматривать и редактировать, а для конфликтов — выбрать master или применить изменение из CSV.",
    action:
      "Проверьте полные строки, дубликаты и ошибки. «Применить все конфликты» дополняет АОН у совпадающих опорных номеров и применяет остальные изменения CSV, а «Подтвердить слияние» создаёт одну новую версию.",
    target: '[data-tour="master-merge-review"]',
  },
  {
    id: "search",
    title: "Найдите связку",
    description:
      "Обычный поиск работает по опорному номеру, АОН и постоянному ID строки. Найденный АОН подсвечивается внутри соответствующей связки.",
    action:
      "Введите один номер, когда нужно быстро перейти к конкретной связке.",
    target: '[data-tour="master-search"]',
  },
  {
    id: "advanced-search",
    title: "Используйте расширенный поиск",
    description:
      "Расширенный режим принимает сразу несколько опорных номеров или АОН и выводит все соответствующие связки.",
    action: "Нажмите «Расширенный поиск», чтобы увидеть многострочное поле.",
    target: '[data-tour="master-search"]',
    requiresAction: true,
  },
  {
    id: "filter",
    title: "Отфильтруйте параметры",
    description:
      "Фильтр показывает только общие известные параметры и позволяет выбрать несколько кодов регионов от 1 до 84.",
    action: "Нажмите «Фильтр», чтобы раскрыть доступные параметры и регионы.",
    target: '[data-tour="master-quality-tools"]',
    requiresAction: true,
  },
  {
    id: "quality",
    title: "Проверяйте дубликаты и ошибки",
    description:
      "Повторы опорных номеров и полностью одинаковые строки проверяются отдельно. Навигация последовательно переносит к нужным строкам, а ошибки длины, первой цифры и пробелов остаются только подсветкой.",
    action:
      "Приложение показывает расположение проблемы и не исправляет данные автоматически.",
    target: '[data-tour="master-quality-tools"]',
  },
  {
    id: "records",
    title: "Работайте с текущей базой",
    description:
      "В списке показываются ID, опорный номер, АОН, параметр и версия строки. По умолчанию на странице 10 записей — размер страницы можно увеличить.",
    action:
      "Чекбокс слева выбирает конкретную физическую строку; кнопка «Отметить всю выборку» учитывает активный фильтр и все страницы.",
    target: '[data-tour="master-records-panel"]',
  },
  {
    id: "add-edit",
    title: "Добавьте или измените строку",
    description:
      "Редактор принимает опорный номер, список АОН, параметр и заметный текстовый комментарий. Если АОН не указан, опорный номер автоматически становится собственным АОН.",
    action:
      "Нажмите «Добавить строку», чтобы открыть редактор. Сохранять учебную строку не требуется.",
    target: '[data-tour="master-quality-tools"]',
    requiresAction: true,
  },
  {
    id: "bulk-delete-a",
    title: "Пакетное удаление опорных номеров",
    description:
      "Блок удаляет сразу несколько опорных номеров вместе со всеми привязанными АОН и записывает операцию в одну версию истории.",
    action: "Раскройте блок, чтобы увидеть формат списка номеров.",
    target: '[data-tour="master-bulk-delete-a"]',
    requiresAction: true,
  },
  {
    id: "bulk-delete-b",
    title: "Пакетное удаление АОН",
    description:
      "Этот вариант удаляет каждый указанный АОН во всём мастер-файле. Если связка останется без АОН, в неё будет подставлен опорный номер.",
    action: "Раскройте блок пакетного удаления АОН.",
    target: '[data-tour="master-bulk-delete-b"]',
    requiresAction: true,
  },
  {
    id: "scoped-delete",
    title: "Удаление АОН у выбранных опор",
    description:
      "Сначала отметьте физические строки чекбоксами или выберите всю отфильтрованную выдачу, затем укажите АОН. Остальные строки не изменятся.",
    action: "Раскройте блок адресного удаления АОН.",
    target: '[data-tour="master-scoped-delete"]',
    requiresAction: true,
  },
  {
    id: "history",
    title: "Откройте историю изменений",
    description:
      "Журнал хранит добавления, изменения, удаления строк и удалённые АОН, с версией, датой, источником и полным составом связки.",
    action: "Нажмите вкладку «История изменений».",
    target: '[data-tour="master-tabs"]',
    requiresAction: true,
  },
  {
    id: "history-dates",
    title: "Отберите изменения по дате",
    description:
      "Диапазон дат ограничивает журнал нужным периодом. История также поддерживает поиск и подгружает следующие 200 изменений при прокрутке.",
    action:
      "При необходимости задайте начальную и конечную даты. Для завершения обучения заполнять поля не нужно.",
    target: '[data-tour="master-history-dates"]',
  },
  {
    id: "complete",
    title: "Обучение мастер-файлу завершено",
    description:
      "Теперь вы знаете полный рабочий цикл: занять файл, проверить и объединить данные, найти или изменить связку и проверить историю версии.",
    action:
      "Нажмите «Готово». Кнопка обучения останется доступна в правой части страницы.",
  },
];
type MasterBatchPanel = "a" | "b" | "scoped-b" | "";
type MasterParameterKind =
  | "default"
  | "pani"
  | "region"
  | "pani-region"
  | "custom";

type MasterDraft = {
  version: 3;
  userId: string;
  savedAt: number;
  view: View;
  query: string;
  filterOpen: boolean;
  selectedParameterGroups: string[];
  selectedRegions: number[];
  duplicatesOnly: boolean;
  exactDuplicatesOnly: boolean;
  shortAonOnly?: boolean;
  historyDateFrom: string;
  historyDateTo: string;
  editor: {
    editing: MasterRecord | null;
    showEditor: boolean;
    aNumber: string;
    bNumbersText: string;
    sourcePrefix: string;
    comment: string;
  } | null;
  analysis: ImportAnalysis | null;
  selectedConflicts: string[];
  replaceAll: boolean;
  analysisDuplicateCursor: number;
};

const NO_REGION_PREFIX = "null/$ & null/$ & null/$ &";
const MASTER_IMPORT_EXTENSIONS = [".csv", ".xlsx", ".xls", ".xlsb"];
const MASTER_IMPORT_ACCEPT = MASTER_IMPORT_EXTENSIONS.join(",");
const EMPTY_MASTER_LOCK: MasterLockState = {
  locked: false,
  ownedByCurrentUser: false,
  ownedByCurrentSession: false,
  owner: null,
  acquiredAt: null,
  notification: null,
};
const ACTION_LABELS = {
  added: "Добавлено",
  updated: "Изменено",
  deleted: "Удалено",
  restored: "Восстановлено",
  cleared: "Очистка",
};

class ApiError extends Error {}

function randomSessionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parseError(payload: unknown, status: number) {
  if (payload && typeof payload === "object") {
    const root = payload as Record<string, unknown>;
    const detail =
      root.detail && typeof root.detail === "object"
        ? (root.detail as Record<string, unknown>)
        : root;
    if (typeof detail.message === "string") return detail.message;
  }
  return `Сервер вернул ошибку ${status}`;
}

function formatDate(value: number) {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value * 1000));
}

function masterVersion(revision: number) {
  return `T2-${revision}`;
}

function localDateTimestamp(value: string, nextDay = false) {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (nextDay) date.setDate(date.getDate() + 1);
  return date.getTime() / 1000;
}

function parseNumbers(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[\s,;]+/)
        .map((item) => item.trim().replace(/^\+/, ""))
        .filter(Boolean),
    ),
  );
}

function editableNumberEntries(value: string) {
  return value
    .split(/[;,\r\n]+/)
    .map((raw) => ({ raw, value: raw.trim().replace(/^\+/, "") }))
    .filter((entry) => entry.value || entry.raw.length > 0);
}

function hasInvalidNumberWhitespace(value: string) {
  return /\s/.test(value);
}

function hasInvalidNumberLength(value: string) {
  return value.trim().length !== 11;
}

function hasInvalidNumberStart(value: string) {
  const normalized = value.trim().replace(/^\+/, "");
  return !!normalized && !normalized.startsWith("7");
}

function isSingleShortAon(numbers: string[]) {
  return numbers.length === 1 && /^\d{3,5}$/.test(numbers[0]);
}

function invalidBNumbers(numbers: string[]) {
  if (isSingleShortAon(numbers)) return [];
  return numbers.filter(hasInvalidNumberLength);
}

function invalidStartBNumbers(numbers: string[]) {
  if (isSingleShortAon(numbers)) return [];
  return numbers.filter(hasInvalidNumberStart);
}

function aonNumberClass(value: string, numbers: string[]) {
  return [
    invalidBNumbers(numbers).includes(value) ? "is-invalid-number" : "",
    invalidStartBNumbers(numbers).includes(value)
      ? "is-invalid-number-start"
      : "",
    isSingleShortAon(numbers) && numbers[0] === value
      ? "is-short-aon-number"
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function recordHasInvalidNumbers(record: Pick<MasterRecord, "aNumber" | "bNumbers">) {
  return (
    hasInvalidNumberLength(record.aNumber) ||
    invalidBNumbers(record.bNumbers).length > 0
  );
}

function recordHasInvalidNumberStart(
  record: Pick<MasterRecord, "aNumber" | "bNumbers">,
) {
  return (
    hasInvalidNumberStart(record.aNumber) ||
    invalidStartBNumbers(record.bNumbers).length > 0
  );
}

function recordHasInvalidNumberWhitespace(
  record: Pick<MasterRecord, "aNumber" | "bNumbers">,
) {
  return (
    hasInvalidNumberWhitespace(record.aNumber) ||
    record.bNumbers.some(hasInvalidNumberWhitespace)
  );
}

function conflictAddsAons(item: ImportItem) {
  return (
    item.current !== null &&
    item.current.aNumber === item.incoming.aNumber &&
    item.current.sourcePrefix === item.incoming.sourcePrefix
  );
}

function conflictAdditionalAonCount(item: ImportItem) {
  if (!item.current || !conflictAddsAons(item)) return 0;
  const current = new Set(item.current.bNumbers);
  return item.incoming.bNumbers.filter((number) => !current.has(number)).length;
}

function masterParameterParts(value: string): {
  kind: MasterParameterKind;
  pani: string;
  region: string;
  custom: string;
} {
  if (!value || value === NO_REGION_PREFIX)
    return { kind: "default", pani: "", region: "", custom: value };
  const pani = value.match(/^(.*?)& null\/\$ & null\/\$ &$/);
  if (pani)
    return {
      kind: "pani",
      pani: pani[1].replace(/^\+/, ""),
      region: "",
      custom: value,
    };
  const region = value.match(/^null\/\$ & null&D?(.*?)\$&$/);
  if (region)
    return {
      kind: "region",
      pani: "",
      region: region[1],
      custom: value,
    };
  const combined =
    value.match(/^(.*?)& D?(.*?)\$&null&$/) ??
    value.match(/^(.*?)& null&D?(.*?)\$&$/);
  if (combined)
    return {
      kind: "pani-region",
      pani: combined[1].replace(/^\+/, ""),
      region: combined[2],
      custom: value,
    };
  return { kind: "custom", pani: "", region: "", custom: value };
}

function masterParameterPrefix(
  kind: MasterParameterKind,
  pani = "",
  region = "",
  custom = "",
) {
  if (kind === "default") return NO_REGION_PREFIX;
  if (kind === "pani") return `${pani}& null/$ & null/$ &`;
  if (kind === "region") return `null/$ & null&D${region}$&`;
  if (kind === "pani-region") return `${pani}& D${region}$&null&`;
  return custom;
}

function masterParameterError(value: string) {
  const parts = masterParameterParts(value);
  if ((parts.kind === "pani" || parts.kind === "pani-region") &&
      !/^[0-9]{11}$/.test(parts.pani))
    return "PANI должен состоять ровно из 11 цифр.";
  if ((parts.kind === "region" || parts.kind === "pani-region") &&
      (!/^[0-9]+$/.test(parts.region) ||
        Number(parts.region) < 1 ||
        Number(parts.region) > 84))
    return "Код региона должен быть числом от 1 до 84.";
  if (parts.kind === "custom") {
    const ampersands = value.match(/&/g)?.length ?? 0;
    if (!value || /[\r\n\u0000=;]/.test(value) || !value.endsWith("&") || ampersands !== 3)
      return "Свой параметр должен содержать три символа «&» и оканчиваться на «&».";
  }
  return "";
}

function MasterParameterEditor({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const parts = masterParameterParts(value);
  const setKind = (kind: MasterParameterKind) =>
    onChange(
      kind === "custom"
        ? "null& null& null&"
        : masterParameterPrefix(kind),
    );
  const error = masterParameterError(value);
  return (
    <div className="master-parameter-editor">
      <label className="field master-parameter-field">
        <span>Параметр строки</span>
        <select
          value={parts.kind}
          onChange={(event) => setKind(event.target.value as MasterParameterKind)}
          disabled={disabled}
        >
          <option value="default">По умолчанию</option>
          <option value="pani">PANI</option>
          <option value="region">Код региона</option>
          <option value="pani-region">PANI + код региона</option>
          <option value="custom">Свой параметр</option>
        </select>
      </label>
      {(parts.kind === "pani" || parts.kind === "pani-region") && (
        <label className="field">
          <span>Номер PANI</span>
          <input
            value={parts.pani}
            onChange={(event) =>
              onChange(
                masterParameterPrefix(
                  parts.kind,
                  event.target.value.replace(/\D/g, "").slice(0, 11),
                  parts.region,
                ),
              )
            }
            inputMode="numeric"
            maxLength={11}
            placeholder="79947013851"
            disabled={disabled}
          />
        </label>
      )}
      {(parts.kind === "region" || parts.kind === "pani-region") && (
        <label className="field">
          <span>Код региона</span>
          <input
            value={parts.region}
            onChange={(event) =>
              onChange(
                masterParameterPrefix(
                  parts.kind,
                  parts.pani,
                  event.target.value.replace(/\D/g, "").slice(0, 2),
                ),
              )
            }
            inputMode="numeric"
            maxLength={2}
            placeholder="29"
            disabled={disabled}
          />
          <small>Число от 1 до 84.</small>
        </label>
      )}
      {parts.kind === "custom" && (
        <label className="field">
          <span>Введите свой параметр</span>
          <input
            value={parts.custom}
            onChange={(event) => onChange(event.target.value)}
            maxLength={256}
            disabled={disabled}
          />
        </label>
      )}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

function formattedImportLine(record: ImportRecord) {
  const bNumbers = record.bNumbers.length
    ? record.bNumbers
    : [record.aNumber];
  const [first, ...rest] = bNumbers;
  const parameter = masterParameterParts(record.sourcePrefix);
  const prefix = masterParameterPrefix(
    parameter.kind,
    parameter.pani,
    parameter.region,
    parameter.custom,
  );
  const firstBMarker =
    bNumbers.length === 1 && first.length >= 3 && first.length <= 5
      ? "4:2"
      : "4:4";
  return `${prefix}${record.aNumber}=${firstBMarker},1,${first}${rest
    .map((number) => `;4,1,${number}`)
    .join("")}`;
}

function importProgressLabel(task: ImportTask) {
  if (task.progressPhase === "queued") return "Файл поставлен в очередь";
  if (task.progressPhase === "reading") return "Читаем и проверяем строки";
  if (task.progressPhase === "comparing")
    return "Сравниваем уникальные связки с мастер-файлом";
  return "Обрабатываем мастер-файл";
}

function masterDraftStorageKey(userId: string) {
  return `carousel-master-draft:${userId}`;
}

function activeMasterImportStorageKey(userId: string) {
  return `carousel-master-active-import:${userId}`;
}

function readMasterDraft(userId: string): MasterDraft | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(masterDraftStorageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MasterDraft>;
    if (
      parsed.version !== 3 ||
      parsed.userId !== userId ||
      typeof parsed.savedAt !== "number"
    ) {
      localStorage.removeItem(masterDraftStorageKey(userId));
      return null;
    }
    return parsed as MasterDraft;
  } catch {
    localStorage.removeItem(masterDraftStorageKey(userId));
    return null;
  }
}

function HighlightedValue({
  value,
  query,
}: {
  value: string;
  query: string;
}) {
  const matches = parseNumbers(query)
    .map((token) => ({
      token,
      index: value.toLowerCase().indexOf(token.toLowerCase()),
    }))
    .filter((match) => match.index >= 0)
    .sort((left, right) => left.index - right.index || right.token.length - left.token.length);
  if (!matches.length) return <>{value}</>;
  const { token, index: matchAt } = matches[0];
  if (matchAt < 0) return <>{value}</>;
  return (
    <>
      {value.slice(0, matchAt)}
      <mark className="master-search-highlight">
        {value.slice(matchAt, matchAt + token.length)}
      </mark>
      {value.slice(matchAt + token.length)}
    </>
  );
}

function visibleBNumbers(
  numbers: string[],
  query: string,
  limit = 6,
  prioritizeInvalid = false,
) {
  const normalized = parseNumbers(query).map((token) => token.toLowerCase());
  const invalid = prioritizeInvalid
    ? numbers.filter(hasInvalidNumberLength)
    : [];
  if (!normalized.length)
    return Array.from(new Set([...invalid, ...numbers])).slice(0, limit);
  const matching = numbers.filter((number) =>
    normalized.some((token) => number.toLowerCase().includes(token)),
  );
  return Array.from(new Set([...matching, ...invalid, ...numbers])).slice(
    0,
    limit,
  );
}

function matchingAon(numbers: string[], query: string) {
  const tokens = parseNumbers(query).filter((token) => /^[0-9]+$/.test(token));
  return numbers.find((number) => tokens.includes(number)) ??
    numbers.find((number) => tokens.some((token) => number.includes(token))) ??
    "";
}

function HighlightedTextareaValue({
  value,
  query,
  highlightInvalidNumbers = false,
  allowedShortAon = "",
}: {
  value: string;
  query: string;
  highlightInvalidNumbers?: boolean;
  allowedShortAon?: string;
}) {
  const renderLine = (line: string) => {
    if (!highlightInvalidNumbers)
      return <HighlightedValue value={line} query={query} />;
    if (line && hasInvalidNumberWhitespace(line))
      return <mark className="is-invalid-number-whitespace">{line}</mark>;
    const parts = line.split(/(\+?[0-9]+)/g);
    return (
      <>
        {parts.map((part, index) => {
          const isNumber = /^\+?[0-9]+$/.test(part);
          const isAllowedShortAon = part === allowedShortAon;
          const classes = isNumber
            ? [
                hasInvalidNumberLength(part) && !isAllowedShortAon
                  ? "is-invalid-number"
                  : "",
                hasInvalidNumberStart(part) && !isAllowedShortAon
                  ? "is-invalid-number-start"
                  : "",
              ]
                .filter(Boolean)
                .join(" ")
            : "";
          return classes ? (
            <mark
              className={classes}
              key={`${part}-${index}`}
            >
              {part}
            </mark>
          ) : (
            <Fragment key={`${part}-${index}`}>
              <HighlightedValue value={part} query={query} />
            </Fragment>
          );
        })}
      </>
    );
  };
  return (
    <>
      {value.split("\n").map((line, index) => (
        <Fragment key={`${line}-${index}`}>
          {index > 0 && "\n"}
          {renderLine(line)}
        </Fragment>
      ))}
    </>
  );
}

function scrollTextareaToAon(
  textarea: HTMLTextAreaElement | null,
  overlay: HTMLPreElement | null,
  value: string,
  query: string,
) {
  if (!textarea || !overlay) return;
  const lines = value.split("\n");
  const matchIndex = lines.findIndex((line) => matchingAon([line], query));
  const lineHeight =
    Number.parseFloat(window.getComputedStyle(textarea).lineHeight) || 19;
  const nextScroll = Math.max(0, matchIndex * lineHeight - lineHeight);
  textarea.scrollTop = nextScroll;
  overlay.scrollTop = nextScroll;
}

function snapshotChanges(item: HistoryItem) {
  const before = item.before;
  const after = item.after;
  if (item.action === "cleared") {
    const count = Number(
      (before as { clearedCount?: number } | null)?.clearedCount ?? 0,
    );
    return [
      count > 0
        ? `Полная очистка мастер-файла · удалено строк ${count}`
        : "Полная очистка мастер-файла",
    ];
  }
  if (!before && after)
    return [`Создана связка с ${after.bNumbers.length} АОН`];
  if (before && !after)
    return [`Удалена связка и ${before.bNumbers.length} АОН`];
  if (!before || !after) return [];
  const changes: string[] = [];
  if (before.aNumber !== after.aNumber)
    changes.push(`Опора: ${before.aNumber} → ${after.aNumber}`);
  const beforeB = new Set(before.bNumbers);
  const afterB = new Set(after.bNumbers);
  const added = after.bNumbers.filter((number) => !beforeB.has(number));
  const removed = before.bNumbers.filter((number) => !afterB.has(number));
  if (added.length) changes.push(`Добавлены АОН: ${added.length}`);
  if (removed.length) changes.push(`Удалены АОН: ${removed.length}`);
  if (
    !added.length &&
    !removed.length &&
    before.bNumbers.join("|") !== after.bNumbers.join("|")
  )
    changes.push("Изменён порядок АОН");
  if (before.sourcePrefix !== after.sourcePrefix)
    changes.push(
      `Параметр: ${before.sourcePrefix} → ${after.sourcePrefix}`,
    );
  if ((before.comment ?? "") !== (after.comment ?? ""))
    changes.push(
      after.comment
        ? `Комментарий: ${after.comment}`
        : "Комментарий удалён",
    );
  return changes.length ? changes : ["Данные строки сохранены без отличий"];
}

function historyItemHasInvalidNumbers(item: HistoryItem) {
  if (item.action === "cleared") return false;
  return [item.before, item.after].some(
    (snapshot) => snapshot && recordHasInvalidNumbers(snapshot),
  );
}

function historyItemHasInvalidNumberStart(item: HistoryItem) {
  if (item.action === "cleared") return false;
  return [item.before, item.after].some(
    (snapshot) => snapshot && recordHasInvalidNumberStart(snapshot),
  );
}

function historyItemHasInvalidNumberWhitespace(item: HistoryItem) {
  if (item.action === "cleared") return false;
  return [item.before, item.after].some(
    (snapshot) => snapshot && recordHasInvalidNumberWhitespace(snapshot),
  );
}

function historyNumberClass(value: string, bNumbers?: string[]) {
  const isAllowedShortAon = bNumbers
    ? isSingleShortAon(bNumbers) && bNumbers[0] === value
    : false;
  return [
    hasInvalidNumberLength(value) && !isAllowedShortAon
      ? "is-invalid-number"
      : "",
    hasInvalidNumberStart(value) && !isAllowedShortAon
      ? "is-invalid-number-start"
      : "",
    isAllowedShortAon ? "is-short-aon-number" : "",
    hasInvalidNumberWhitespace(value) ? "is-invalid-number-whitespace" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function HistoryAonDetails({ item }: { item: HistoryItem }) {
  const before = item.before?.bNumbers ?? [];
  const after = item.after?.bNumbers ?? [];
  const current = item.after ? after : before;
  return (
    <details className="history-aon-details">
      <summary>
        АОН внутри опорного номера · до: {before.length}, после: {after.length}
      </summary>
      <div className="history-aon-scroll">
        {!!item.removedBNumbers.length && (
          <section className="history-aon-group is-removed">
            <strong>Удалены при этом изменении</strong>
            <div>
              {item.removedBNumbers.map((number, index) => (
                <code
                  className={historyNumberClass(number, before)}
                  key={`${number}-${index}`}
                >
                  {number}
                </code>
              ))}
            </div>
          </section>
        )}
        {!!item.addedBNumbers.length && (
          <section className="history-aon-group is-added">
            <strong>Добавлены при этом изменении</strong>
            <div>
              {item.addedBNumbers.map((number, index) => (
                <code
                  className={historyNumberClass(number, after)}
                  key={`${number}-${index}`}
                >
                  {number}
                </code>
              ))}
            </div>
          </section>
        )}
        <section className="history-aon-group">
          <strong>
            {item.after ? "Состояние после изменения" : "Состояние до удаления"}
          </strong>
          <div>
            {current.map((number, index) => (
              <code
                className={historyNumberClass(number, current)}
                key={`${number}-${index}`}
              >
                {number}
              </code>
            ))}
          </div>
        </section>
      </div>
    </details>
  );
}

export default function MasterPage() {
  const { authorizedFetch, user } = useAuth();
  const searchParams = useSearchParams();
  const sessionId = useRef("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recordRefs = useRef(new Map<string, HTMLTableRowElement>());
  const analysisDuplicateRefs = useRef(new Map<string, HTMLElement>());
  const inlineEditorRef = useRef<HTMLDivElement>(null);
  const searchInlineEditorRef = useRef<HTMLDivElement>(null);
  const editorBTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editorBOverlayRef = useRef<HTMLPreElement>(null);
  const searchBTextareaRef = useRef<HTMLTextAreaElement>(null);
  const searchBOverlayRef = useRef<HTMLPreElement>(null);
  const importBTextareaRef = useRef<HTMLTextAreaElement>(null);
  const importBOverlayRef = useRef<HTMLPreElement>(null);
  const queuedImportRef = useRef("");
  const queuedImportLockRef = useRef("");
  const importPollingRef = useRef("");
  const importRecoveryUserRef = useRef("");
  const notifiedLockRef = useRef("");
  const notifiedOwnerRef = useRef("");
  const ownedLockRef = useRef(false);
  const recordsLoadingMoreRef = useRef(false);
  const historyLoadingMoreRef = useRef(false);
  const recordsLoadGenerationRef = useRef(0);
  const historyLoadGenerationRef = useRef(0);
  const tutorialInitializedRef = useRef(false);
  const analysisImportIdRef = useRef("");
  const [view, setView] = useState<View>("records");
  const [recordsPageSize, setRecordsPageSize] = useState<RecordPageSize>(
    DEFAULT_RECORD_PAGE_SIZE,
  );
  const [recordsOffset, setRecordsOffset] = useState(0);
  const [records, setRecords] = useState<MasterRecord[]>([]);
  const [recordsHasMore, setRecordsHasMore] = useState(false);
  const [recordsLoadingMore, setRecordsLoadingMore] = useState(false);
  const [recordStats, setRecordStats] = useState({
    revision: 0,
    total: 0,
    activeCount: 0,
    totalB: 0,
    invalidANumberCount: 0,
    invalidBNumberCount: 0,
    invalidRecordCount: 0,
    invalidStartANumberCount: 0,
    invalidStartBNumberCount: 0,
    invalidStartRecordCount: 0,
    shortAonRecordCount: 0,
  });
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyDateFrom, setHistoryDateFrom] = useState("");
  const [historyDateTo, setHistoryDateTo] = useState("");
  const [parameterOptions, setParameterOptions] = useState<ParameterOption[]>([]);
  const [regionOptions, setRegionOptions] = useState<RegionOption[]>([]);
  const [selectedParameterGroups, setSelectedParameterGroups] = useState<
    string[]
  >([]);
  const [selectedRegions, setSelectedRegions] = useState<number[]>([]);
  const [regionInput, setRegionInput] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [duplicateCount, setDuplicateCount] = useState(0);
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  const [duplicateCursor, setDuplicateCursor] = useState(0);
  const [exactDuplicateCount, setExactDuplicateCount] = useState(0);
  const [exactDuplicateExtraCount, setExactDuplicateExtraCount] = useState(0);
  const [matchingExactDuplicateExtraCount, setMatchingExactDuplicateExtraCount] =
    useState(0);
  const [exactDuplicatesOnly, setExactDuplicatesOnly] = useState(false);
  const [exactDuplicateCursor, setExactDuplicateCursor] = useState(0);
  const [shortAonOnly, setShortAonOnly] = useState(false);
  const [invalidOnly, setInvalidOnly] = useState(false);
  const [invalidCursor, setInvalidCursor] = useState(0);
  const [invalidStartOnly, setInvalidStartOnly] = useState(false);
  const [invalidStartCursor, setInvalidStartCursor] = useState(0);
  const [analysisDuplicateCursor, setAnalysisDuplicateCursor] = useState(0);
  const [duplicatePreviewItems, setDuplicatePreviewItems] = useState<
    ImportAnalysis["duplicates"]
  >([]);
  const [duplicatePreviewLoading, setDuplicatePreviewLoading] = useState(false);
  const [duplicatePreviewHasMore, setDuplicatePreviewHasMore] = useState(false);
  const [query, setQuery] = useState("");
  const [advancedSearchOpen, setAdvancedSearchOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [warning, setWarning] = useState("");
  const [uploading, setUploading] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportTask | null>(null);
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [newPreviewItems, setNewPreviewItems] = useState<ImportItem[]>([]);
  const [newPreviewOpen, setNewPreviewOpen] = useState(false);
  const [newPreviewLoading, setNewPreviewLoading] = useState(false);
  const [newPreviewHasMore, setNewPreviewHasMore] = useState(false);
  const [conflictPreviewItems, setConflictPreviewItems] = useState<ImportItem[]>([]);
  const [conflictPreviewLoading, setConflictPreviewLoading] = useState(false);
  const [conflictPreviewHasMore, setConflictPreviewHasMore] = useState(false);
  const [editingImportItemId, setEditingImportItemId] = useState("");
  const [importEditANumber, setImportEditANumber] = useState("");
  const [importEditBNumbers, setImportEditBNumbers] = useState("");
  const [importEditSourcePrefix, setImportEditSourcePrefix] = useState(
    NO_REGION_PREFIX,
  );
  const [savingImportItem, setSavingImportItem] = useState(false);
  const [merging, setMerging] = useState(false);
  const [selectedConflicts, setSelectedConflicts] = useState<string[]>([]);
  const [replaceAll, setReplaceAll] = useState(false);
  const [mergeDuplicateANumbers, setMergeDuplicateANumbers] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [editing, setEditing] = useState<MasterRecord | null>(null);
  const [logicalRowPreview, setLogicalRowPreview] =
    useState<MasterRecord | null>(null);
  const [copiedLogicalRow, setCopiedLogicalRow] = useState(false);
  const [aNumber, setANumber] = useState("");
  const [bNumbersText, setBNumbersText] = useState("");
  const [sourcePrefix, setSourcePrefix] = useState(NO_REGION_PREFIX);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [masterLock, setMasterLock] =
    useState<MasterLockState>(EMPTY_MASTER_LOCK);
  const [lockLoading, setLockLoading] = useState(true);
  const [lockChanging, setLockChanging] = useState(false);
  const [lockDialogOpen, setLockDialogOpen] = useState(false);
  const [ownerNotificationOpen, setOwnerNotificationOpen] = useState(false);
  const [notifyingLockOwner, setNotifyingLockOwner] = useState(false);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [clearingMaster, setClearingMaster] = useState(false);
  const [resetHistoryDialogOpen, setResetHistoryDialogOpen] = useState(false);
  const [resettingHistory, setResettingHistory] = useState(false);
  const [bulkDeleteANumbers, setBulkDeleteANumbers] = useState("");
  const [bulkDeleteBNumbers, setBulkDeleteBNumbers] = useState("");
  const [scopedDeleteANumbers, setScopedDeleteANumbers] = useState("");
  const [scopedDeleteBNumbers, setScopedDeleteBNumbers] = useState("");
  const [selectedRecordIds, setSelectedRecordIds] = useState<string[]>([]);
  const [selectedAllFilterKey, setSelectedAllFilterKey] = useState("");
  const [serverSelectionMode, setServerSelectionMode] = useState<
    "filter" | "exact-duplicate-extras" | ""
  >("");
  const [excludedSelectedRecordIds, setExcludedSelectedRecordIds] = useState<
    string[]
  >([]);
  const [batchPanel, setBatchPanel] = useState<MasterBatchPanel>("");
  const [bulkDeleting, setBulkDeleting] = useState<
    "a" | "b" | "scoped-b" | "exact-duplicate-extras" | ""
  >("");
  const [pendingDraft, setPendingDraft] = useState<MasterDraft | null>(null);
  const [draftDialogOpen, setDraftDialogOpen] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const [masterTutorialOpen, setMasterTutorialOpen] = useState(false);
  const [masterTutorialStep, setMasterTutorialStep] =
    useState<MasterTutorialStep>("welcome");

  const setImportAnalysis = useCallback(
    (next: ImportAnalysis | null) => {
      const nextImportId = next?.importId ?? "";
      if (analysisImportIdRef.current !== nextImportId) {
        analysisImportIdRef.current = nextImportId;
        setMergeDuplicateANumbers(false);
      }
      if (!next || !next.stats) {
        setNewPreviewItems([]);
        setNewPreviewOpen(false);
        setNewPreviewHasMore(false);
        setConflictPreviewItems([]);
        setConflictPreviewHasMore(false);
        setDuplicatePreviewItems([]);
        setDuplicatePreviewHasMore(false);
        setEditingImportItemId("");
        setAnalysis(null);
        return;
      }
      const previewItems = next?.items ?? [];
      const nextNewItems = previewItems.filter((item) => item.status === "new");
      const nextConflictItems = previewItems.filter(
        (item) => item.status === "conflict",
      );
      setNewPreviewItems(nextNewItems);
      setNewPreviewOpen(false);
      setNewPreviewHasMore(
        nextNewItems.length < next.stats.new,
      );
      setConflictPreviewItems(nextConflictItems);
      setConflictPreviewHasMore(
        nextConflictItems.length < next.stats.conflict,
      );
      setDuplicatePreviewItems(next?.duplicates ?? []);
      setDuplicatePreviewHasMore(
        (next.duplicates?.length ?? 0) < next.stats.duplicateGroups,
      );
      setEditingImportItemId("");
      setAnalysis(next);
    },
    [],
  );

  useEffect(() => {
    const key = "carousel-session-id";
    let current = localStorage.getItem(key);
    if (!current) {
      current = randomSessionId();
      localStorage.setItem(key, current);
    }
    sessionId.current = current;
  }, []);

  useEffect(() => {
    if (!logicalRowPreview) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLogicalRowPreview(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [logicalRowPreview]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (!user) return;
      const storedDraft = readMasterDraft(user.id);
      if (storedDraft) {
        setPendingDraft(storedDraft);
        setDraftDialogOpen(true);
        setDraftReady(false);
      } else {
        setPendingDraft(null);
        setDraftDialogOpen(false);
        setDraftReady(true);
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [user]);

  useEffect(() => {
    if (
      tutorialInitializedRef.current ||
      searchParams.get("tutorial") !== "master"
    )
      return;
    tutorialInitializedRef.current = true;
    const timer = window.setTimeout(() => {
      setMasterTutorialStep("welcome");
      setMasterTutorialOpen(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [searchParams]);

  const getSessionId = useCallback(() => {
    if (!sessionId.current) {
      sessionId.current = randomSessionId();
      if (typeof localStorage !== "undefined")
        localStorage.setItem("carousel-session-id", sessionId.current);
    }
    return sessionId.current;
  }, []);

  const apiFetch = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("X-Session-ID", getSessionId());
      if (
        init.body &&
        !(init.body instanceof FormData) &&
        !headers.has("Content-Type")
      )
        headers.set("Content-Type", "application/json");
      const response = await authorizedFetch(path, { ...init, headers });
      if (!response.ok) {
        let payload: unknown = null;
        try {
          payload = await response.json();
        } catch {
          // The status text below is sufficient when a proxy returned HTML.
        }
        throw new ApiError(parseError(payload, response.status));
      }
      return response;
    },
    [authorizedFetch, getSessionId],
  );

  const waitForImportAnalysis = useCallback(
    async (importId: string) => {
      if (!importId) return;
      importPollingRef.current = importId;
      setUploading(true);
      if (user && typeof localStorage !== "undefined")
        localStorage.setItem(activeMasterImportStorageKey(user.id), importId);
      try {
        while (importPollingRef.current === importId) {
          const response = await apiFetch(
            `/api/master/imports/${encodeURIComponent(importId)}`,
          );
          const payload = (await response.json()) as ImportTask | ImportAnalysis;
          setImportProgress(payload);
          if (payload.status === "merging") {
            setMerging(true);
            setUploading(false);
            await new Promise((resolve) => window.setTimeout(resolve, 1000));
            continue;
          }
          if (payload.status === "merged") {
            const mergeResult =
              "mergeResult" in payload
                ? payload.mergeResult
                : "stats" in payload &&
                    payload.stats &&
                    typeof payload.stats === "object" &&
                    "mergeResult" in payload.stats
                  ? (
                      payload.stats as {
                        mergeResult?: ImportTask["mergeResult"];
                      }
                    ).mergeResult
                  : undefined;
            if (mergeResult) {
              setNotice(
                `Слияние выполнено: добавлено ${mergeResult.added}, обновлено ${mergeResult.updated}, оставлено без изменений ${mergeResult.keptConflicts}. Версия ${masterVersion(mergeResult.revision)}.`,
              );
            } else {
              setNotice("Слияние выполнено.");
            }
            setImportAnalysis(null);
            setMerging(false);
            importPollingRef.current = "";
            setImportProgress(null);
            if (user && typeof localStorage !== "undefined")
              localStorage.removeItem(activeMasterImportStorageKey(user.id));
            return;
          }
          if (payload.status === "analyzed") {
            if (!("stats" in payload))
              throw new Error("Сервер не вернул результат анализа файла.");
            setImportAnalysis(payload);
            setAnalysisDuplicateCursor(0);
            if (payload.errorMessage) {
              setError(payload.errorMessage);
            } else {
              setNotice(
                payload.stats.conflict > 0
                  ? "Проверка завершена. Новые строки будут добавлены автоматически, конфликты требуют решения."
                  : "Проверка завершена. Конфликтов нет. Подтвердите слияние с мастер файлом.",
              );
              setError("");
            }
            importPollingRef.current = "";
            setImportProgress(null);
            setMerging(false);
            if (user && typeof localStorage !== "undefined")
              localStorage.removeItem(activeMasterImportStorageKey(user.id));
            return;
          }
          if (payload.status === "failed") {
            throw new Error(
              payload.errorMessage || "Не удалось проверить мастер-файл.",
            );
          }
          await new Promise((resolve) => window.setTimeout(resolve, 750));
        }
      } catch (nextError) {
        setImportProgress(null);
        setMerging(false);
        if (user && typeof localStorage !== "undefined")
          localStorage.removeItem(activeMasterImportStorageKey(user.id));
        throw nextError;
      } finally {
        if (importPollingRef.current === importId)
          importPollingRef.current = "";
        setUploading(false);
      }
    },
    [apiFetch, setImportAnalysis, user],
  );

  useEffect(
    () => () => {
      importPollingRef.current = "";
    },
    [],
  );

  useEffect(() => {
    if (!user || importRecoveryUserRef.current === user.id || analysis) return;
    importRecoveryUserRef.current = user.id;
    const recover = async () => {
      try {
        const storedImportId = localStorage.getItem(
          activeMasterImportStorageKey(user.id),
        );
        if (storedImportId) {
          await waitForImportAnalysis(storedImportId);
          return;
        }
        const response = await apiFetch("/api/master/imports/active");
        const payload = (await response.json()) as {
          active: ImportTask | null;
        };
        if (payload.active)
          await waitForImportAnalysis(payload.active.importId);
      } catch (nextError) {
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Не удалось восстановить анализ мастер-файла.",
        );
      }
    };
    void recover();
  }, [analysis, apiFetch, user, waitForImportAnalysis]);

  const applyMasterLock = useCallback((nextLock: MasterLockState) => {
    const ownedHere = Boolean(
      nextLock.ownedByCurrentUser && nextLock.ownedByCurrentSession,
    );
    ownedLockRef.current = ownedHere;
    setMasterLock({
      ...nextLock,
      ownedByCurrentSession: Boolean(nextLock.ownedByCurrentSession),
    });
    const notificationKey =
      nextLock.locked && !nextLock.ownedByCurrentUser && nextLock.owner
        ? `${nextLock.owner.id}:${nextLock.acquiredAt ?? ""}`
        : "";
    if (notificationKey && notifiedLockRef.current !== notificationKey) {
      notifiedLockRef.current = notificationKey;
      setLockDialogOpen(true);
    }
    if (!notificationKey) notifiedLockRef.current = "";
    const ownerNotification = nextLock.notification;
    if (
      ownedHere &&
      ownerNotification &&
      notifiedOwnerRef.current !== ownerNotification.id
    ) {
      notifiedOwnerRef.current = ownerNotification.id;
      setOwnerNotificationOpen(true);
    }
    if (!nextLock.locked) {
      notifiedOwnerRef.current = "";
      setOwnerNotificationOpen(false);
    }
  }, []);

  const loadMasterLock = useCallback(async () => {
    try {
      const response = await apiFetch("/api/master/lock");
      applyMasterLock((await response.json()) as MasterLockState);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Не удалось проверить доступность мастер-файла.",
      );
    } finally {
      setLockLoading(false);
    }
  }, [apiFetch, applyMasterLock]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadMasterLock(), 0);
    const interval = window.setInterval(() => void loadMasterLock(), 5000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void loadMasterLock();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
      document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange,
      );
    };
  }, [loadMasterLock]);

  const releaseMasterForNavigation = useCallback(async () => {
    if (!ownedLockRef.current) return true;
    try {
      const response = await apiFetch("/api/master/lock", {
        method: "DELETE",
      });
      applyMasterLock((await response.json()) as MasterLockState);
      return true;
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? `Не удалось освободить мастер-файл: ${nextError.message}`
          : "Не удалось освободить мастер-файл перед переходом.",
      );
      return false;
    }
  }, [apiFetch, applyMasterLock]);

  useEffect(
    () => () => {
      if (!ownedLockRef.current) return;
      ownedLockRef.current = false;
      void apiFetch("/api/master/lock", { method: "DELETE" }).catch(() => {
        // Обычный fetch отменяется браузером при обновлении страницы, поэтому
        // сохранённая сессия блокировки переживает refresh, как и раньше.
      });
    },
    [apiFetch],
  );

  const loadRecords = useCallback(async (offset = 0) => {
    const reset = offset === 0;
    if (!reset && recordsLoadingMoreRef.current) return;
    const generation = reset
      ? ++recordsLoadGenerationRef.current
      : recordsLoadGenerationRef.current;
    if (reset) {
      recordsLoadingMoreRef.current = false;
      setRecordsLoadingMore(false);
      setLoading(true);
    }
    else {
      recordsLoadingMoreRef.current = true;
      setRecordsLoadingMore(true);
      setLoading(true);
    }
    try {
      const parameters = new URLSearchParams({
        query,
        offset: String(offset),
        limit: String(recordsPageSize),
      });
      for (const group of selectedParameterGroups)
        parameters.append("parameterGroup", group);
      for (const region of selectedRegions)
        parameters.append("region", String(region));
      if (duplicatesOnly) parameters.set("duplicatesOnly", "true");
      if (exactDuplicatesOnly)
        parameters.set("exactDuplicatesOnly", "true");
      if (shortAonOnly) parameters.set("shortAonOnly", "true");
      if (invalidOnly) parameters.set("invalidOnly", "true");
      if (invalidStartOnly) parameters.set("invalidStartOnly", "true");
      const response = await apiFetch(
        `/api/master/records?${parameters.toString()}`,
      );
      const payload = await response.json();
      if (generation !== recordsLoadGenerationRef.current) return;
      const pageItems: MasterRecord[] = Array.isArray(payload.items)
        ? (payload.items as MasterRecord[])
        : [];
      setRecords(pageItems);
      setRecordsOffset(offset);
      setRecordsHasMore(offset + pageItems.length < Number(payload.total));
      setParameterOptions(
        Array.isArray(payload.parameterOptions)
          ? payload.parameterOptions
          : [],
      );
      setRegionOptions(
        Array.isArray(payload.regionOptions) ? payload.regionOptions : [],
      );
      setDuplicateCount(Number(payload.duplicateCount) || 0);
      setExactDuplicateCount(Number(payload.exactDuplicateCount) || 0);
      setExactDuplicateExtraCount(
        Number(payload.exactDuplicateExtraCount) || 0,
      );
      setMatchingExactDuplicateExtraCount(
        Number(payload.matchingExactDuplicateExtraCount) || 0,
      );
      setRecordStats({
        revision: Number(payload.revision) || 0,
        total: Number(payload.total) || 0,
        activeCount: Number(payload.activeCount) || 0,
        totalB: Number(payload.totalB) || 0,
        invalidANumberCount: Number(payload.invalidANumberCount) || 0,
        invalidBNumberCount: Number(payload.invalidBNumberCount) || 0,
        invalidRecordCount: Number(payload.invalidRecordCount) || 0,
        invalidStartANumberCount:
          Number(payload.invalidStartANumberCount) || 0,
        invalidStartBNumberCount:
          Number(payload.invalidStartBNumberCount) || 0,
        invalidStartRecordCount:
          Number(payload.invalidStartRecordCount) || 0,
        shortAonRecordCount: Number(payload.shortAonRecordCount) || 0,
      });
      setHistoryTotal(Number(payload.historyCount) || 0);
      setError("");
    } catch (nextError) {
      if (generation !== recordsLoadGenerationRef.current) return;
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Не удалось загрузить исходную базу.",
      );
    } finally {
      if (generation === recordsLoadGenerationRef.current) {
        setLoading(false);
        recordsLoadingMoreRef.current = false;
        setRecordsLoadingMore(false);
      }
    }
  }, [
    apiFetch,
    duplicatesOnly,
    exactDuplicatesOnly,
    invalidOnly,
    invalidStartOnly,
    query,
    recordsPageSize,
    selectedParameterGroups,
    selectedRegions,
    shortAonOnly,
  ]);

  const loadHistory = useCallback(async (offset = 0) => {
    const reset = offset === 0;
    if (!reset && historyLoadingMoreRef.current) return;
    const generation = reset
      ? ++historyLoadGenerationRef.current
      : historyLoadGenerationRef.current;
    const dateFrom = localDateTimestamp(historyDateFrom);
    const dateTo = localDateTimestamp(historyDateTo, true);
    if (dateFrom !== null && dateTo !== null && dateFrom >= dateTo) {
      if (reset) setHistory([]);
      setHistoryTotal(0);
      setHistoryHasMore(false);
      setError("Дата начала периода должна быть не позже даты окончания.");
      setLoading(false);
      return;
    }
    if (reset) {
      historyLoadingMoreRef.current = false;
      setHistoryLoadingMore(false);
      setLoading(true);
    }
    else {
      historyLoadingMoreRef.current = true;
      setHistoryLoadingMore(true);
    }
    try {
      const parameters = new URLSearchParams({
        query,
        offset: String(offset),
        limit: "200",
      });
      if (dateFrom !== null) parameters.set("dateFrom", String(dateFrom));
      if (dateTo !== null) parameters.set("dateTo", String(dateTo));
      const response = await apiFetch(
        `/api/master/history?${parameters.toString()}`,
      );
      const payload = await response.json();
      if (generation !== historyLoadGenerationRef.current) return;
      const pageItems: HistoryItem[] = Array.isArray(payload.items)
        ? (payload.items as HistoryItem[])
        : [];
      setHistory((current) => {
        const combined = reset ? pageItems : [...current, ...pageItems];
        return Array.from(
          new Map(combined.map((item) => [item.id, item])).values(),
        );
      });
      setHistoryTotal(Number(payload.total) || 0);
      setHistoryHasMore(offset + pageItems.length < Number(payload.total));
      setError("");
    } catch (nextError) {
      if (generation !== historyLoadGenerationRef.current) return;
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Не удалось загрузить журнал изменений.",
      );
    } finally {
      if (generation === historyLoadGenerationRef.current) {
        if (reset) setLoading(false);
        else {
          historyLoadingMoreRef.current = false;
          setHistoryLoadingMore(false);
        }
      }
    }
  }, [apiFetch, historyDateFrom, historyDateTo, query]);

  const loadNewPreviewPage = useCallback(
    async (reset = false) => {
      if (!analysis || newPreviewLoading) return;
      const offset = reset ? 0 : newPreviewItems.length;
      setNewPreviewLoading(true);
      try {
        const parameters = new URLSearchParams({
          status: "new",
          offset: String(offset),
          limit: "200",
        });
        const response = await apiFetch(
          `/api/master/imports/${analysis.importId}/items?${parameters.toString()}`,
        );
        const payload = (await response.json()) as {
          total: number;
          items: ImportItem[];
        };
        const pageItems = Array.isArray(payload.items)
          ? payload.items
          : [];
        setNewPreviewItems((current) => {
          const combined = reset ? pageItems : [...current, ...pageItems];
          return Array.from(
            new Map(combined.map((item) => [item.id, item])).values(),
          );
        });
        setNewPreviewHasMore(offset + pageItems.length < payload.total);
      } catch (nextError) {
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Не удалось загрузить новые строки.",
        );
      } finally {
        setNewPreviewLoading(false);
      }
    },
    [
      analysis,
      apiFetch,
      newPreviewItems.length,
      newPreviewLoading,
    ],
  );

  const loadConflictPreviewPage = useCallback(async () => {
    if (!analysis || conflictPreviewLoading) return;
    const offset = conflictPreviewItems.length;
    setConflictPreviewLoading(true);
    try {
      const parameters = new URLSearchParams({
        status: "conflict",
        offset: String(offset),
        limit: "200",
      });
      const response = await apiFetch(
        `/api/master/imports/${analysis.importId}/items?${parameters.toString()}`,
      );
      const payload = (await response.json()) as {
        total: number;
        items: ImportItem[];
      };
      const pageItems = Array.isArray(payload.items) ? payload.items : [];
      setConflictPreviewItems((current) =>
        Array.from(
          new Map([...current, ...pageItems].map((item) => [item.id, item])).values(),
        ),
      );
      setConflictPreviewHasMore(offset + pageItems.length < payload.total);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Не удалось загрузить следующие конфликты.",
      );
    } finally {
      setConflictPreviewLoading(false);
    }
  }, [
    analysis,
    apiFetch,
    conflictPreviewItems.length,
    conflictPreviewLoading,
  ]);

  const loadDuplicatePreviewPage = useCallback(async () => {
    if (!analysis || duplicatePreviewLoading) return;
    const offset = duplicatePreviewItems.length;
    setDuplicatePreviewLoading(true);
    try {
      const parameters = new URLSearchParams({
        offset: String(offset),
        limit: "200",
      });
      const response = await apiFetch(
        `/api/master/imports/${analysis.importId}/duplicates?${parameters.toString()}`,
      );
      const payload = (await response.json()) as {
        total: number;
        items: ImportAnalysis["duplicates"];
      };
      const pageItems = Array.isArray(payload.items) ? payload.items : [];
      setDuplicatePreviewItems((current) =>
        Array.from(
          new Map(
            [...current, ...pageItems].map((item) => [item.aNumber, item]),
          ).values(),
        ),
      );
      setDuplicatePreviewHasMore(offset + pageItems.length < payload.total);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Не удалось загрузить следующие группы дубликатов.",
      );
    } finally {
      setDuplicatePreviewLoading(false);
    }
  }, [
    analysis,
    apiFetch,
    duplicatePreviewItems.length,
    duplicatePreviewLoading,
  ]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (view === "records") void loadRecords(0);
      else void loadHistory(0);
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [loadHistory, loadRecords, view]);

  const conflictItems = conflictPreviewItems;
  const mergeNumberStartWarnings = useMemo(() => {
    if (!analysis) return [];
    const selected = new Set(selectedConflicts);
    return (analysis.numberStartErrors ?? []).filter(
      (item) =>
        item.status === "new" ||
        (item.status === "conflict" &&
          (replaceAll || selected.has(item.itemId))),
    );
  }, [analysis, replaceAll, selectedConflicts]);
  const duplicateRecords = useMemo(
    () => records.filter((record) => record.isDuplicate),
    [records],
  );
  const exactDuplicateRecords = useMemo(
    () => records.filter((record) => record.isExactDuplicate),
    [records],
  );
  const invalidRecords = useMemo(
    () => records.filter(recordHasInvalidNumbers),
    [records],
  );
  const invalidStartRecords = useMemo(
    () => records.filter(recordHasInvalidNumberStart),
    [records],
  );
  const scopedSelectedANumbers = useMemo(
    () => parseNumbers(scopedDeleteANumbers),
    [scopedDeleteANumbers],
  );
  const recordFilter = useMemo(
    () => ({
      query,
      parameterGroups: selectedParameterGroups,
      regions: selectedRegions,
      duplicatesOnly,
      exactDuplicatesOnly,
      shortAonOnly,
      invalidOnly,
      invalidStartOnly,
    }),
    [
      duplicatesOnly,
      exactDuplicatesOnly,
      invalidOnly,
      invalidStartOnly,
      query,
      selectedParameterGroups,
      selectedRegions,
      shortAonOnly,
    ],
  );
  const recordFilterKey = JSON.stringify(recordFilter);
  const allFilteredRecordsSelected =
    serverSelectionMode === "filter" &&
    selectedAllFilterKey === recordFilterKey &&
    !!selectedAllFilterKey;
  const exactDuplicateExtrasSelected =
    serverSelectionMode === "exact-duplicate-extras" &&
    selectedAllFilterKey === recordFilterKey &&
    !!selectedAllFilterKey;
  const serverFilteredRecordsSelected =
    allFilteredRecordsSelected || exactDuplicateExtrasSelected;
  const selectedServerFilter = exactDuplicateExtrasSelected
    ? { ...recordFilter, exactDuplicateExtrasOnly: true }
    : recordFilter;
  const selectedRecordIdSet = useMemo(
    () => new Set(selectedRecordIds),
    [selectedRecordIds],
  );
  const excludedSelectedRecordIdSet = useMemo(
    () => new Set(excludedSelectedRecordIds),
    [excludedSelectedRecordIds],
  );
  const selectedFilteredRecordCount = serverFilteredRecordsSelected
    ? Math.max(
        0,
        (exactDuplicateExtrasSelected
          ? matchingExactDuplicateExtraCount
          : recordStats.total) - excludedSelectedRecordIds.length,
      )
    : selectedRecordIds.length;
  useEffect(() => {
    if (!selectedAllFilterKey || selectedAllFilterKey === recordFilterKey)
      return;
    const timeout = window.setTimeout(() => {
      setSelectedAllFilterKey("");
      setServerSelectionMode("");
      setExcludedSelectedRecordIds([]);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [recordFilterKey, selectedAllFilterKey]);
  const aonSearchMatches = useMemo(() => {
    const tokens = parseNumbers(query).filter((token) => /^\d+$/.test(token));
    return records
      .map((record) => ({
        record,
        aons: record.bNumbers.filter((number) =>
          tokens.some((token) => number.includes(token)),
        ),
      }))
      .filter((item) => item.aons.length > 0);
  }, [query, records]);
  const aonSearchMatchesByRecord = useMemo(
    () => new Map(aonSearchMatches.map((item) => [item.record.id, item.aons])),
    [aonSearchMatches],
  );
  const aonSearchMatch = useMemo(
    () =>
      aonSearchMatches[0]
        ? {
            record: aonSearchMatches[0].record,
            aon: aonSearchMatches[0].aons[0],
          }
        : null,
    [aonSearchMatches],
  );
  const generalParameterOptions = useMemo(
    () => parameterOptions.filter((option) => option.id !== "region"),
    [parameterOptions],
  );
  const regionRecordCount =
    (parameterOptions.find((option) => option.id === "region")?.count ?? 0) +
    (parameterOptions.find((option) => option.id === "pani_region")?.count ?? 0);
  const focusedDuplicateId =
    duplicatesOnly && duplicateRecords.length
      ? duplicateRecords[duplicateCursor % duplicateRecords.length].id
      : "";
  const focusedExactDuplicateId =
    exactDuplicatesOnly && exactDuplicateRecords.length
      ? exactDuplicateRecords[
          exactDuplicateCursor % exactDuplicateRecords.length
        ].id
      : "";
  const focusedInvalidId =
    invalidOnly && invalidRecords.length
      ? invalidRecords[invalidCursor % invalidRecords.length].id
      : "";
  const focusedInvalidStartId =
    invalidStartOnly && invalidStartRecords.length
      ? invalidStartRecords[
          invalidStartCursor % invalidStartRecords.length
        ].id
      : "";
  const activeFilterCount =
    selectedParameterGroups.length +
    (selectedRegions.length ? 1 : 0) +
    (duplicatesOnly ? 1 : 0) +
    (exactDuplicatesOnly ? 1 : 0) +
    (shortAonOnly ? 1 : 0) +
    (invalidOnly ? 1 : 0) +
    (invalidStartOnly ? 1 : 0);
  const preservedImportRows =
    analysis?.stats.preservedRows ??
    ((analysis?.stats.uniqueA ?? 0) + (analysis?.stats.duplicateA ?? 0));
  const masterEditable =
    masterLock.ownedByCurrentUser && masterLock.ownedByCurrentSession;
  const needsReclaim =
    masterLock.locked &&
    masterLock.ownedByCurrentUser &&
    !masterLock.ownedByCurrentSession;
  const lockedByOther =
    masterLock.locked && !masterLock.ownedByCurrentUser;
  const notifyLockOwner = useCallback(async () => {
    if (!lockedByOther || notifyingLockOwner) return;
    setNotifyingLockOwner(true);
    try {
      await apiFetch("/api/master/lock/notify", {
        method: "POST",
        body: JSON.stringify({ kind: "reminder" }),
      });
      setNotice(
        `Пользователь ${masterLock.owner?.email ?? "владелец блокировки"} получил напоминание освободить мастер-файл.`,
      );
      setLockDialogOpen(false);
      setError("");
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Не удалось отправить уведомление владельцу мастер-файла.",
      );
      await loadMasterLock();
    } finally {
      setNotifyingLockOwner(false);
    }
  }, [
    apiFetch,
    loadMasterLock,
    lockedByOther,
    masterLock.owner,
    notifyingLockOwner,
  ]);
  const draftSnapshot = useMemo<MasterDraft | null>(() => {
    if (!user) return null;
    const editorHasWork =
      editing !== null ||
      (showEditor &&
        Boolean(
          aNumber.trim() ||
            bNumbersText.trim() ||
            sourcePrefix !== NO_REGION_PREFIX ||
            comment.trim(),
        ));
    if (!editorHasWork && !analysis) return null;
    return {
      version: 3,
      userId: user.id,
      savedAt: 0,
      view,
      query,
      filterOpen,
      selectedParameterGroups,
      selectedRegions,
      duplicatesOnly,
      exactDuplicatesOnly,
      shortAonOnly,
      historyDateFrom,
      historyDateTo,
      editor: editorHasWork
        ? {
            editing,
            showEditor,
            aNumber,
            bNumbersText,
            sourcePrefix,
            comment,
          }
        : null,
      analysis,
      selectedConflicts,
      replaceAll,
      analysisDuplicateCursor,
    };
  }, [
    aNumber,
    analysis,
    analysisDuplicateCursor,
    bNumbersText,
    comment,
    duplicatesOnly,
    exactDuplicatesOnly,
    editing,
    filterOpen,
    historyDateFrom,
    historyDateTo,
    query,
    replaceAll,
    selectedConflicts,
    selectedParameterGroups,
    selectedRegions,
    showEditor,
    shortAonOnly,
    sourcePrefix,
    user,
    view,
  ]);

  useEffect(() => {
    if (!user || !draftReady || draftDialogOpen) return;
    const key = masterDraftStorageKey(user.id);
    const persist = () => {
      if (draftSnapshot) {
        localStorage.setItem(
          key,
          JSON.stringify({
            ...draftSnapshot,
            savedAt: Date.now(),
          }),
        );
      } else {
        localStorage.removeItem(key);
      }
    };
    persist();
    return persist;
  }, [draftDialogOpen, draftReady, draftSnapshot, user]);

  useEffect(() => {
    if (
      view !== "records" ||
      !duplicatesOnly ||
      !duplicateRecords.length
    )
      return;
    const index = duplicateCursor % duplicateRecords.length;
    const record = duplicateRecords[index];
    window.requestAnimationFrame(() => {
      recordRefs.current.get(record.id)?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "center",
      });
    });
  }, [duplicateCursor, duplicateRecords, duplicatesOnly, view]);

  useEffect(() => {
    if (
      view !== "records" ||
      !exactDuplicatesOnly ||
      !exactDuplicateRecords.length
    )
      return;
    const index = exactDuplicateCursor % exactDuplicateRecords.length;
    const record = exactDuplicateRecords[index];
    window.requestAnimationFrame(() => {
      recordRefs.current.get(record.id)?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "center",
      });
    });
  }, [
    exactDuplicateCursor,
    exactDuplicateRecords,
    exactDuplicatesOnly,
    view,
  ]);

  useEffect(() => {
    if (view !== "records" || !invalidOnly || !invalidRecords.length) return;
    const index = invalidCursor % invalidRecords.length;
    const record = invalidRecords[index];
    window.requestAnimationFrame(() => {
      recordRefs.current.get(record.id)?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "center",
      });
    });
  }, [invalidCursor, invalidOnly, invalidRecords, view]);

  useEffect(() => {
    if (
      view !== "records" ||
      !invalidStartOnly ||
      !invalidStartRecords.length
    )
      return;
    const index = invalidStartCursor % invalidStartRecords.length;
    const record = invalidStartRecords[index];
    window.requestAnimationFrame(() => {
      recordRefs.current.get(record.id)?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "center",
      });
    });
  }, [invalidStartCursor, invalidStartOnly, invalidStartRecords, view]);

  const showNextDuplicate = async () => {
    if (!duplicateCount) return;
    setView("records");
    setFilterOpen(false);
    if (!duplicatesOnly) {
      setQuery("");
      setSelectedParameterGroups([]);
      setSelectedRegions([]);
      setInvalidOnly(false);
      setInvalidCursor(0);
      setInvalidStartOnly(false);
      setInvalidStartCursor(0);
      setExactDuplicatesOnly(false);
      setExactDuplicateCursor(0);
      setShortAonOnly(false);
      setDuplicatesOnly(true);
      setDuplicateCursor(0);
      return;
    }
    const currentIndex = duplicateCursor % Math.max(duplicateRecords.length, 1);
    if (
      duplicateRecords.length > 0 &&
      currentIndex === duplicateRecords.length - 1 &&
      recordsHasMore
    ) {
      await loadRecords(recordsOffset + recordsPageSize);
      setDuplicateCursor(0);
      return;
    }
    setDuplicateCursor(
      (current) => (current + 1) % Math.max(duplicateRecords.length, 1),
    );
  };

  const showNextExactDuplicate = async () => {
    if (!exactDuplicateCount) return;
    setView("records");
    setFilterOpen(false);
    if (!exactDuplicatesOnly) {
      setQuery("");
      setSelectedParameterGroups([]);
      setSelectedRegions([]);
      setDuplicatesOnly(false);
      setDuplicateCursor(0);
      setInvalidOnly(false);
      setInvalidCursor(0);
      setInvalidStartOnly(false);
      setInvalidStartCursor(0);
      setShortAonOnly(false);
      setExactDuplicatesOnly(true);
      setExactDuplicateCursor(0);
      return;
    }
    const currentIndex =
      exactDuplicateCursor % Math.max(exactDuplicateRecords.length, 1);
    if (
      exactDuplicateRecords.length > 0 &&
      currentIndex === exactDuplicateRecords.length - 1 &&
      recordsHasMore
    ) {
      await loadRecords(recordsOffset + recordsPageSize);
      setExactDuplicateCursor(0);
      return;
    }
    setExactDuplicateCursor(
      (current) =>
        (current + 1) % Math.max(exactDuplicateRecords.length, 1),
    );
  };

  const showNextInvalidNumber = async () => {
    if (!recordStats.invalidRecordCount) return;
    setView("records");
    setFilterOpen(false);
    if (!invalidOnly) {
      setQuery("");
      setSelectedParameterGroups([]);
      setSelectedRegions([]);
      setDuplicatesOnly(false);
      setDuplicateCursor(0);
      setExactDuplicatesOnly(false);
      setExactDuplicateCursor(0);
      setShortAonOnly(false);
      setInvalidStartOnly(false);
      setInvalidStartCursor(0);
      setInvalidOnly(true);
      setInvalidCursor(0);
      return;
    }
    const currentIndex = invalidCursor % Math.max(invalidRecords.length, 1);
    if (
      invalidRecords.length > 0 &&
      currentIndex === invalidRecords.length - 1 &&
      recordsHasMore
    ) {
      await loadRecords(recordsOffset + recordsPageSize);
      setInvalidCursor(0);
      return;
    }
    setInvalidCursor(
      (current) => (current + 1) % Math.max(invalidRecords.length, 1),
    );
  };

  const showNextInvalidStart = async () => {
    if (!recordStats.invalidStartRecordCount) return;
    setView("records");
    setFilterOpen(false);
    if (!invalidStartOnly) {
      setQuery("");
      setSelectedParameterGroups([]);
      setSelectedRegions([]);
      setDuplicatesOnly(false);
      setDuplicateCursor(0);
      setExactDuplicatesOnly(false);
      setExactDuplicateCursor(0);
      setShortAonOnly(false);
      setInvalidOnly(false);
      setInvalidCursor(0);
      setInvalidStartOnly(true);
      setInvalidStartCursor(0);
      return;
    }
    const currentIndex =
      invalidStartCursor % Math.max(invalidStartRecords.length, 1);
    if (
      invalidStartRecords.length > 0 &&
      currentIndex === invalidStartRecords.length - 1 &&
      recordsHasMore
    ) {
      await loadRecords(recordsOffset + recordsPageSize);
      setInvalidStartCursor(0);
      return;
    }
    setInvalidStartCursor(
      (current) =>
        (current + 1) % Math.max(invalidStartRecords.length, 1),
    );
  };

  const showShortAonRecords = () => {
    setView("records");
    setFilterOpen(false);
    if (shortAonOnly) {
      setShortAonOnly(false);
      return;
    }
    setQuery("");
    setSelectedParameterGroups([]);
    setSelectedRegions([]);
    setDuplicatesOnly(false);
    setDuplicateCursor(0);
    setExactDuplicatesOnly(false);
    setExactDuplicateCursor(0);
    setInvalidOnly(false);
    setInvalidCursor(0);
    setInvalidStartOnly(false);
    setInvalidStartCursor(0);
    setShortAonOnly(true);
  };

  const addRegionSelection = () => {
    const value = Number(regionInput.trim());
    if (!Number.isInteger(value) || value < 1 || value > 84) {
      setError("Введите код региона цифрой от 1 до 84.");
      return;
    }
    setSelectedRegions((current) =>
      current.includes(value)
        ? current
        : [...current, value].sort((left, right) => left - right),
    );
    setRegionInput("");
    setError("");
  };

  const toggleScopedANumber = (aNumber: string, checked: boolean) => {
    setScopedDeleteANumbers((current) => {
      const currentNumbers = parseNumbers(current);
      const next = checked
        ? Array.from(new Set([...currentNumbers, aNumber]))
        : currentNumbers.filter((number) => number !== aNumber);
      return next.join("\n");
    });
  };

  const toggleAllFilteredRecords = () => {
    if (allFilteredRecordsSelected) {
      setSelectedAllFilterKey("");
      setServerSelectionMode("");
      setExcludedSelectedRecordIds([]);
      return;
    }
    setSelectedRecordIds([]);
    setExcludedSelectedRecordIds([]);
    setSelectedAllFilterKey(recordFilterKey);
    setServerSelectionMode("filter");
  };

  const toggleExactDuplicateExtras = () => {
    if (exactDuplicateExtrasSelected) {
      clearRecordSelection();
      return;
    }
    setSelectedRecordIds([]);
    setExcludedSelectedRecordIds([]);
    setSelectedAllFilterKey(recordFilterKey);
    setServerSelectionMode("exact-duplicate-extras");
  };

  const toggleRecordSelection = (recordId: string, checked: boolean) => {
    if (serverFilteredRecordsSelected) {
      setExcludedSelectedRecordIds((current) =>
        checked
          ? current.filter((id) => id !== recordId)
          : Array.from(new Set([...current, recordId])),
      );
      return;
    }
    setSelectedRecordIds((current) =>
      checked
        ? Array.from(new Set([...current, recordId]))
        : current.filter((id) => id !== recordId),
    );
  };

  const clearRecordSelection = () => {
    setSelectedRecordIds([]);
    setSelectedAllFilterKey("");
    setServerSelectionMode("");
    setExcludedSelectedRecordIds([]);
  };

  const openLogicalRowPreview = (record: MasterRecord) => {
    setCopiedLogicalRow(false);
    setLogicalRowPreview(record);
  };

  const copyLogicalRowPreview = async () => {
    if (!logicalRowPreview) return;
    const value =
      logicalRowPreview.logicalRow ?? formattedImportLine(logicalRowPreview);
    try {
      await navigator.clipboard.writeText(value);
      setCopiedLogicalRow(true);
    } catch {
      setError("Не удалось скопировать строку. Выделите её вручную.");
    }
  };

  const showNextAnalysisDuplicate = async () => {
    if (!duplicatePreviewItems.length) return;
    const index = analysisDuplicateCursor % duplicatePreviewItems.length;
    const duplicate = duplicatePreviewItems[index];
    analysisDuplicateRefs.current.get(duplicate.aNumber)?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "center",
    });
    if (
      index === duplicatePreviewItems.length - 1 &&
      duplicatePreviewHasMore
    ) {
      await loadDuplicatePreviewPage();
      setAnalysisDuplicateCursor(duplicatePreviewItems.length);
      return;
    }
    setAnalysisDuplicateCursor((current) =>
      (current + 1) % duplicatePreviewItems.length,
    );
  };

  const resetEditor = () => {
    setEditing(null);
    setANumber("");
    setBNumbersText("");
    setSourcePrefix(NO_REGION_PREFIX);
    setComment("");
    setShowEditor(false);
  };

  const continueDraft = () => {
    if (!pendingDraft) return;
    setView(pendingDraft.view);
    setQuery(pendingDraft.query);
    setFilterOpen(pendingDraft.filterOpen);
    setSelectedParameterGroups(pendingDraft.selectedParameterGroups);
    setSelectedRegions(pendingDraft.selectedRegions);
    setDuplicatesOnly(pendingDraft.duplicatesOnly);
    setExactDuplicatesOnly(pendingDraft.exactDuplicatesOnly ?? false);
    setShortAonOnly(pendingDraft.shortAonOnly ?? false);
    setHistoryDateFrom(pendingDraft.historyDateFrom);
    setHistoryDateTo(pendingDraft.historyDateTo);
    setEditing(pendingDraft.editor?.editing ?? null);
    setShowEditor(pendingDraft.editor?.showEditor ?? false);
    setANumber(pendingDraft.editor?.aNumber ?? "");
    setBNumbersText(pendingDraft.editor?.bNumbersText ?? "");
    setSourcePrefix(
      pendingDraft.editor?.sourcePrefix ?? NO_REGION_PREFIX,
    );
    setComment(pendingDraft.editor?.comment ?? "");
    setImportAnalysis(pendingDraft.analysis);
    setSelectedConflicts(pendingDraft.selectedConflicts);
    setReplaceAll(pendingDraft.replaceAll);
    setAnalysisDuplicateCursor(pendingDraft.analysisDuplicateCursor);
    setPendingDraft(null);
    setDraftDialogOpen(false);
    setDraftReady(true);
    setNotice(
      masterEditable
        ? "Незавершённая работа восстановлена."
        : "Незавершённая работа восстановлена. Займите мастер-файл, чтобы продолжить редактирование.",
    );
  };

  const discardDraft = () => {
    if (user)
      localStorage.removeItem(masterDraftStorageKey(user.id));
    resetEditor();
    setImportAnalysis(null);
    setSelectedConflicts([]);
    setReplaceAll(false);
    setPendingDraft(null);
    setDraftDialogOpen(false);
    setDraftReady(true);
    setNotice("Незавершённая работа удалена.");
  };

  const toggleMasterLock = async () => {
    if (lockedByOther) return;
    const reclaiming = needsReclaim;
    setLockChanging(true);
    try {
      // Своя сессия → освободить; чужая сессия того же пользователя → перехватить (POST);
      // свободно → занять (POST).
      const releasing = masterEditable;
      const response = await apiFetch("/api/master/lock", {
        method: releasing ? "DELETE" : "POST",
      });
      const nextLock = (await response.json()) as MasterLockState;
      applyMasterLock(nextLock);
      if (releasing) {
        resetEditor();
        setImportAnalysis(null);
        setSelectedConflicts([]);
        setReplaceAll(false);
        setNotice("Мастер-файл освобождён для других пользователей.");
      } else if (reclaiming) {
        setNotice(
          "Мастер-файл перехвачен в этой вкладке. Другая ваша сессия больше не редактирует файл.",
        );
      } else {
        setNotice(
          "Мастер-файл занят вами. Остальные пользователи работают в режиме просмотра.",
        );
      }
      setError("");
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Не удалось изменить состояние мастер-файла.",
      );
      await loadMasterLock();
    } finally {
      setLockChanging(false);
    }
  };

  const openCreate = () => {
    if (!masterEditable) return;
    setEditing(null);
    setANumber("");
    setBNumbersText("");
    setSourcePrefix(NO_REGION_PREFIX);
    setComment("");
    setShowEditor(true);
    setError("");
  };

  const populateRecordEditor = (record: MasterRecord) => {
    setEditing(record);
    setANumber(record.aNumber);
    setBNumbersText(record.bNumbers.join("\n"));
    setSourcePrefix(record.sourcePrefix);
    setComment(record.comment ?? "");
    setShowEditor(false);
    setError("");
  };

  const openEdit = (record: MasterRecord) => {
    if (!masterEditable) return;
    populateRecordEditor(record);
  };

  const openInvalidRecordForEdit = async (record: MasterRecord) => {
    if (masterEditable) {
      populateRecordEditor(record);
      return;
    }
    if (lockedByOther) {
      setLockDialogOpen(true);
      return;
    }
    setLockChanging(true);
    try {
      const response = await apiFetch("/api/master/lock", {
        method: "POST",
      });
      const nextLock = (await response.json()) as MasterLockState;
      applyMasterLock(nextLock);
      if (!nextLock.ownedByCurrentUser) {
        setLockDialogOpen(true);
        return;
      }
      populateRecordEditor(record);
      setNotice(
        "Мастер-файл автоматически занят вами. Исправьте найденные номера и сохраните строку.",
      );
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Не удалось занять мастер-файл для исправления номера.",
      );
      await loadMasterLock();
    } finally {
      setLockChanging(false);
    }
  };

  useEffect(() => {
    if (!editing) return;
    window.requestAnimationFrame(() => {
      inlineEditorRef.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "nearest",
      });
      scrollTextareaToAon(
        editorBTextareaRef.current,
        editorBOverlayRef.current,
        bNumbersText,
        query,
      );
    });
  }, [bNumbersText, editing, query]);

  useEffect(() => {
    if (!aonSearchMatch || editing?.id === aonSearchMatch.record.id) return;
    const value = aonSearchMatch.record.bNumbers.join("\n");
    window.requestAnimationFrame(() => {
      searchInlineEditorRef.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "nearest",
      });
      scrollTextareaToAon(
        searchBTextareaRef.current,
        searchBOverlayRef.current,
        value,
        query,
      );
    });
  }, [aonSearchMatch, editing, query]);

  const saveRecord = async () => {
    if (!masterEditable) return;
    const bNumberEntries = editableNumberEntries(bNumbersText);
    if (!aNumber.trim()) {
      setError("Укажите опорный номер.");
      return;
    }
    const bNumbers = Array.from(
      new Set(bNumberEntries.map((entry) => entry.value).filter(Boolean)),
    );
    const parameterError = masterParameterError(sourcePrefix);
    if (parameterError) {
      setError(parameterError);
      return;
    }
    setSaving(true);
    try {
      const path = editing
        ? `/api/master/records/${editing.id}`
        : "/api/master/records";
      await apiFetch(path, {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify({
          aNumber,
          bNumbers,
          sourcePrefix,
          comment,
          expectedVersion: editing?.version,
        }),
      });
      setNotice(editing ? "Строка обновлена и записана в историю." : "Новая строка добавлена в исходную базу.");
      resetEditor();
      await loadRecords(recordsOffset);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Не удалось сохранить строку.",
      );
    } finally {
      setSaving(false);
    }
  };

  const deleteRecord = async (record: MasterRecord) => {
    if (!masterEditable) return;
    if (
      !window.confirm(
        `Удалить строку ${record.lineNumber} с опорой ${record.aNumber}? Изменение останется в истории.`,
      )
    )
      return;
    try {
      await apiFetch(
        `/api/master/records/${record.id}?expectedVersion=${record.version}`,
        { method: "DELETE" },
      );
      setNotice(`Строка ${record.lineNumber} удалена. Снимок сохранён в истории.`);
      await loadRecords(recordsOffset);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Не удалось удалить строку.",
      );
    }
  };

  const batchDeleteA = async () => {
    if (!masterEditable) return;
    const aNumbers = parseNumbers(bulkDeleteANumbers);
    if (!aNumbers.length) {
      setError("Укажите опорные номера для пакетного удаления.");
      return;
    }
    if (
      !window.confirm(
        `Отметить на удаление ${aNumbers.length} опорных номеров вместе со всеми АОН? Операция будет записана в историю.`,
      )
    )
      return;
    setBulkDeleting("a");
    try {
      const response = await apiFetch(
        "/api/master/records/batch-delete-a",
        {
          method: "POST",
          body: JSON.stringify({ aNumbers }),
        },
      );
      const result = (await response.json()) as {
        revision: number;
        deleted: number;
        notFound: number;
      };
      setBulkDeleteANumbers("");
      setNotice(
        `Пакетное удаление завершено: удалено опорных номеров ${result.deleted}, не найдено ${result.notFound}. Версия ${masterVersion(result.revision)}.`,
      );
      setError("");
      await loadRecords(0);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Не удалось пакетно удалить опорные номера.",
      );
    } finally {
      setBulkDeleting("");
    }
  };

  const batchDeleteB = async () => {
    if (!masterEditable) return;
    const bNumbers = parseNumbers(bulkDeleteBNumbers);
    if (!bNumbers.length) {
      setError("Укажите АОН для пакетного удаления.");
      return;
    }
    if (
      !window.confirm(
        `Удалить ${bNumbers.length} указанных АОН из всех связок мастер-файла? Если связка останется без АОН, в неё будет подставлен опорный номер.`,
      )
    )
      return;
    setBulkDeleting("b");
    try {
      const response = await apiFetch(
        "/api/master/records/batch-delete-b",
        {
          method: "POST",
          body: JSON.stringify({ bNumbers }),
        },
      );
      const result = (await response.json()) as {
        revision: number;
        updatedRecords: number;
        removedAons: number;
      };
      setBulkDeleteBNumbers("");
      setNotice(
        `Пакетное удаление АОН завершено: обновлено связок ${result.updatedRecords}, удалено АОН ${result.removedAons}. Версия ${masterVersion(result.revision)}.`,
      );
      setError("");
      await loadRecords(0);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Не удалось пакетно удалить АОН.",
      );
    } finally {
      setBulkDeleting("");
    }
  };

  const batchDeleteBForSelectedA = async () => {
    if (!masterEditable) return;
    const selectedANumbers = parseNumbers(scopedDeleteANumbers);
    const bNumbers = parseNumbers(scopedDeleteBNumbers);
    if (
      (!selectedANumbers.length && !selectedFilteredRecordCount) ||
      !bNumbers.length
    ) {
      setError(
        "Отметьте строки или укажите опорные номера и АОН для удаления из выбранных связок.",
      );
      return;
    }
    if (
      !window.confirm(
        `Удалить ${bNumbers.length} АОН у отмеченных строк: ${selectedFilteredRecordCount}, опорных номеров вручную: ${selectedANumbers.length}? Остальные связки мастер-файла не изменятся.`,
      )
    )
      return;
    setWarning("");
    setBulkDeleting("scoped-b");
    try {
      const response = await apiFetch(
        "/api/master/records/batch-delete-b-scoped",
        {
          method: "POST",
          body: JSON.stringify({
            aNumbers: selectedANumbers,
            recordIds: serverFilteredRecordsSelected ? [] : selectedRecordIds,
            excludedRecordIds: serverFilteredRecordsSelected
              ? excludedSelectedRecordIds
              : [],
            filter: serverFilteredRecordsSelected ? selectedServerFilter : null,
            bNumbers,
          }),
        },
      );
      const result = (await response.json()) as {
        revision: number;
        updatedRecords: number;
        removedAons: number;
        notFoundRecords: number;
        notLinkedBNumbers: string[];
      };
      setScopedDeleteANumbers("");
      setScopedDeleteBNumbers("");
      clearRecordSelection();
      setNotice(
        `Удаление АОН у выбранных опорных номеров завершено: обновлено связок ${result.updatedRecords}, удалено АОН ${result.removedAons}, не найдено опорных номеров ${result.notFoundRecords}. Версия ${masterVersion(result.revision)}.`,
      );
      setWarning(
        result.notLinkedBNumbers.length
          ? `АОН ${result.notLinkedBNumbers.join(", ")} не были привязаны ни к одному из указанных опорных номеров.`
          : "",
      );
      setError("");
      await loadRecords(0);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Не удалось удалить АОН у выбранных опорных номеров.",
      );
    } finally {
      setBulkDeleting("");
    }
  };

  const deleteSelectedExactDuplicateExtras = async () => {
    if (!masterEditable || !exactDuplicateExtrasSelected) return;
    if (!selectedFilteredRecordCount) {
      setError("В текущей выборке нет лишних полных копий для удаления.");
      return;
    }
    if (
      !window.confirm(
        `Удалить ${selectedFilteredRecordCount} лишних полностью одинаковых строк? В каждой группе останется одна исходная запись.`,
      )
    )
      return;
    setWarning("");
    setBulkDeleting("exact-duplicate-extras");
    try {
      const response = await apiFetch(
        "/api/master/records/delete-exact-duplicate-extras",
        {
          method: "POST",
          body: JSON.stringify({
            filter: recordFilter,
            excludedRecordIds: excludedSelectedRecordIds,
          }),
        },
      );
      const result = (await response.json()) as {
        revision: number;
        deleted: number;
        keptOriginalGroups: number;
      };
      clearRecordSelection();
      setNotice(
        `Удалено лишних полных копий: ${result.deleted}. Сохранено по одному оригиналу в группах: ${result.keptOriginalGroups}. Версия ${masterVersion(result.revision)}.`,
      );
      setError("");
      await loadRecords(0);
      await loadHistory(0);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Не удалось удалить лишние полные копии.",
      );
    } finally {
      setBulkDeleting("");
    }
  };

  const clearMaster = async () => {
    if (!masterEditable || !user?.voiceAdmin) return;
    setClearingMaster(true);
    try {
      const response = await apiFetch("/api/master/records", {
        method: "DELETE",
      });
      const result = (await response.json()) as {
        revision: number;
        deleted: number;
      };
      resetEditor();
      setImportAnalysis(null);
      setSelectedConflicts([]);
      setReplaceAll(false);
      setClearDialogOpen(false);
      setView("records");
      setQuery("");
      setSelectedParameterGroups([]);
      setSelectedRegions([]);
      setDuplicatesOnly(false);
      setDuplicateCursor(0);
      setExactDuplicatesOnly(false);
      setExactDuplicateCursor(0);
      setShortAonOnly(false);
      setInvalidOnly(false);
      setInvalidCursor(0);
      setNotice(
        `Мастер-файл очищен. Удалено строк: ${result.deleted}. Версия ${masterVersion(result.revision)}; в истории — одна запись «Очистка».`,
      );
      setError("");
      await loadRecords(recordsOffset);
    } catch (nextError) {
      setClearDialogOpen(false);
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Не удалось очистить мастер-файл.",
      );
    } finally {
      setClearingMaster(false);
    }
  };

  const resetMasterHistory = async () => {
    if (!masterEditable || !user?.voiceAdmin) return;
    setResettingHistory(true);
    try {
      const response = await apiFetch("/api/master/history", {
        method: "DELETE",
      });
      const result = (await response.json()) as {
        revision: number;
        clearedChanges: number;
        clearedImports: number;
        activeRecords: number;
      };
      setResetHistoryDialogOpen(false);
      setHistory([]);
      setHistoryTotal(0);
      setHistoryHasMore(false);
      setView("records");
      setNotice(
        `Журнал очищен: удалено изменений ${result.clearedChanges}, импортов ${result.clearedImports}. ${result.activeRecords} активных строк сохранены как базовая версия ${masterVersion(result.revision)}.`,
      );
      setError("");
      await loadRecords(0);
    } catch (nextError) {
      setResetHistoryDialogOpen(false);
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Не удалось очистить журнал и обнулить версию.",
      );
    } finally {
      setResettingHistory(false);
    }
  };

  const analyzeFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!masterEditable) {
      setError("Сначала займите мастер-файл.");
      return;
    }
    if (
      !MASTER_IMPORT_EXTENSIONS.some((extension) =>
        file.name.toLowerCase().endsWith(extension),
      )
    ) {
      setError("Для слияния выберите файл CSV, XLSX, XLS или XLSB.");
      return;
    }
    setUploading(true);
    setImportProgress(null);
    setImportAnalysis(null);
    setSelectedConflicts([]);
    setReplaceAll(false);
    try {
      const data = new FormData();
      data.set("file", file);
      const uploadedResponse = await apiFetch("/api/uploads", {
        method: "POST",
        body: data,
      });
      const uploaded = await uploadedResponse.json();
      const analyzeResponse = await apiFetch(
        "/api/master/imports/analyze",
        {
          method: "POST",
          body: JSON.stringify({ uploadId: uploaded.id, mode: "auto" }),
        },
      );
      const task = (await analyzeResponse.json()) as ImportTask;
      setImportProgress(task);
      await waitForImportAnalysis(task.importId);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Не удалось проверить файл.",
      );
    } finally {
      if (!importPollingRef.current) setUploading(false);
    }
  };

  useEffect(() => {
    const uploadId = searchParams.get("importUploadId")?.trim() || "";
    if (!uploadId || queuedImportRef.current === uploadId) return;
    if (!user) return;
    if (!masterEditable) {
      if (lockedByOther || lockChanging) return;
      if (queuedImportLockRef.current === uploadId) return;
      queuedImportLockRef.current = uploadId;
      void (async () => {
        try {
          const response = await apiFetch("/api/master/lock", {
            method: "POST",
          });
          applyMasterLock((await response.json()) as MasterLockState);
        } catch (nextError) {
          queuedImportLockRef.current = "";
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Сначала займите мастер-файл, чтобы принять результат.",
          );
        }
      })();
      return;
    }
    queuedImportRef.current = uploadId;
    const analyzeQueuedResult = async () => {
      setUploading(true);
      setImportProgress(null);
      setImportAnalysis(null);
      setSelectedConflicts([]);
      setReplaceAll(false);
      try {
        const response = await apiFetch("/api/master/imports/analyze", {
          method: "POST",
          body: JSON.stringify({ uploadId, mode: "auto" }),
        });
        const task = (await response.json()) as ImportTask;
        setImportProgress(task);
        await waitForImportAnalysis(task.importId);
        window.history.replaceState({}, "", appHref("/master"));
      } catch (nextError) {
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Не удалось подготовить результат к слиянию.",
        );
        queuedImportRef.current = "";
      } finally {
        if (!importPollingRef.current) setUploading(false);
      }
    };
    void analyzeQueuedResult();
  }, [
    apiFetch,
    applyMasterLock,
    lockChanging,
    lockedByOther,
    masterEditable,
    searchParams,
    setImportAnalysis,
    user,
    waitForImportAnalysis,
  ]);

  const startImportItemEdit = (item: ImportItem) => {
    setEditingImportItemId(item.id);
    setImportEditANumber(item.incoming.aNumber);
    setImportEditBNumbers(item.incoming.bNumbers.join("\n"));
    setImportEditSourcePrefix(item.incoming.sourcePrefix);
    setError("");
  };

  const cancelImportItemEdit = () => {
    setEditingImportItemId("");
    setImportEditANumber("");
    setImportEditBNumbers("");
    setImportEditSourcePrefix(NO_REGION_PREFIX);
  };

  const saveImportItem = async (item: ImportItem) => {
    if (!analysis || !masterEditable) return;
    const bNumberEntries = editableNumberEntries(importEditBNumbers);
    if (!importEditANumber.trim()) {
      setError("Укажите опорный номер.");
      return;
    }
    const bNumbers = Array.from(
      new Set(bNumberEntries.map((entry) => entry.value).filter(Boolean)),
    );
    const parameterError = masterParameterError(importEditSourcePrefix);
    if (parameterError) {
      setError(`Строка CSV ${item.sourceRow}: ${parameterError}`);
      return;
    }
    setSavingImportItem(true);
    try {
      const response = await apiFetch(
        `/api/master/imports/${analysis.importId}/items/${item.id}`,
        {
          method: "PUT",
          body: JSON.stringify({
            aNumber: importEditANumber,
            bNumbers,
            sourcePrefix: importEditSourcePrefix,
          }),
        },
      );
      const payload = (await response.json()) as {
        item: ImportItem;
        stats: ImportAnalysis["stats"];
        numberStartErrors: ImportAnalysis["numberStartErrors"];
      };
      const updated = payload.item;
      setNewPreviewItems((current) =>
        updated.status === "new"
          ? current.map((entry) =>
              entry.id === updated.id ? updated : entry,
            )
          : current.filter((entry) => entry.id !== updated.id),
      );
      setConflictPreviewItems((current) =>
        updated.status === "conflict"
          ? Array.from(
              new Map(
                [...current.filter((entry) => entry.id !== updated.id), updated].map(
                  (entry) => [entry.id, entry],
                ),
              ).values(),
            )
          : current.filter((entry) => entry.id !== updated.id),
      );
      const hadNewPreview = newPreviewItems.some(
        (entry) => entry.id === updated.id,
      );
      const nextNewPreviewCount =
        updated.status === "new"
          ? newPreviewItems.length + (hadNewPreview ? 0 : 1)
          : newPreviewItems.length - (hadNewPreview ? 1 : 0);
      const hadConflictPreview = conflictPreviewItems.some(
        (entry) => entry.id === updated.id,
      );
      const nextConflictPreviewCount =
        updated.status === "conflict"
          ? conflictPreviewItems.length + (hadConflictPreview ? 0 : 1)
          : conflictPreviewItems.length - (hadConflictPreview ? 1 : 0);
      setNewPreviewHasMore(nextNewPreviewCount < payload.stats.new);
      setConflictPreviewHasMore(
        nextConflictPreviewCount < payload.stats.conflict,
      );
      setAnalysis((current) => {
        if (!current) return current;
        const withoutUpdated = current.items.filter(
          (entry) => entry.id !== updated.id,
        );
        return {
          ...current,
          stats: { ...current.stats, ...payload.stats },
          numberStartErrors: payload.numberStartErrors,
          items:
            updated.status === "conflict"
              ? [...withoutUpdated, updated]
              : updated.status === "new"
                ? current.items.map((entry) =>
                    entry.id === updated.id ? updated : entry,
                  )
                : withoutUpdated,
        };
      });
      cancelImportItemEdit();
      setNotice(
        updated.status === "new"
          ? `Строка CSV ${updated.sourceRow} обновлена перед слиянием.`
          : updated.status === "conflict"
            ? `Строка CSV ${updated.sourceRow} обновлена и теперь требует согласования конфликта.`
            : `Строка CSV ${updated.sourceRow} совпала с мастер файлом и не требует слияния.`,
      );
      setError("");
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Не удалось сохранить строку перед слиянием.",
      );
    } finally {
      setSavingImportItem(false);
    }
  };

  const mergeImport = async () => {
    if (!analysis || !masterEditable) return;
    setMerging(true);
    const importId = analysis.importId;
    try {
      const conflictStrategy = replaceAll
        ? "replace_all"
        : selectedConflicts.length
          ? "selected"
          : "keep_all";
      await apiFetch(`/api/master/imports/${importId}/merge`, {
        method: "POST",
        body: JSON.stringify({
          conflictStrategy,
          replaceConflictItemIds: selectedConflicts,
          mergeDuplicateANumbers: false,
        }),
      });
      let result: {
        revision: number;
        added: number;
        updated: number;
        keptConflicts: number;
        mergedDuplicates: number;
        separateDuplicateRows: number;
      } | null = null;
      while (true) {
        const statusResponse = await apiFetch(
          `/api/master/imports/${encodeURIComponent(importId)}`,
        );
        const payload = (await statusResponse.json()) as ImportTask & {
          mergeResult?: typeof result;
          stats?: { mergeResult?: typeof result };
        };
        if (payload.status === "merged") {
          result =
            payload.mergeResult ||
            payload.stats?.mergeResult ||
            null;
          break;
        }
        if (payload.status === "analyzed" && payload.errorMessage) {
          throw new Error(payload.errorMessage);
        }
        if (payload.status === "failed") {
          throw new Error(
            payload.errorMessage || "Не удалось выполнить слияние.",
          );
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
      if (!result) {
        setNotice("Слияние выполнено.");
      } else {
        setNotice(
          `Слияние выполнено: добавлено ${result.added}, обновлено ${result.updated}, оставлено без изменений ${result.keptConflicts}${result.separateDuplicateRows ? `, дубликатов сохранено отдельными строками ${result.separateDuplicateRows}` : ""}${result.mergedDuplicates ? `, объединено повторных строк ${result.mergedDuplicates}` : ""}. Версия ${masterVersion(result.revision)}.`,
        );
      }
      setImportAnalysis(null);
      setSelectedConflicts([]);
      setReplaceAll(false);
      setMergeDuplicateANumbers(false);
      await loadRecords(recordsOffset);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Не удалось выполнить слияние.",
      );
    } finally {
      setMerging(false);
    }
  };

  const downloadMaster = async () => {
    if (!masterEditable) return;
    try {
      const response = await apiFetch("/api/master/export");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "master.csv";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Не удалось выгрузить master.csv.",
      );
    }
  };

  useEffect(() => {
    if (!lockDialogOpen && !ownerNotificationOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLockDialogOpen(false);
        setOwnerNotificationOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [lockDialogOpen, ownerNotificationOpen]);

  useEffect(() => {
    if (!clearDialogOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !clearingMaster)
        setClearDialogOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [clearDialogOpen, clearingMaster]);

  useEffect(() => {
    if (!resetHistoryDialogOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !resettingHistory)
        setResetHistoryDialogOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [resetHistoryDialogOpen, resettingHistory]);

  const currentMasterTutorialStep =
    MASTER_TUTORIAL_STEPS.find((step) => step.id === masterTutorialStep) ??
    MASTER_TUTORIAL_STEPS[0];
  const currentMasterTutorialIndex = MASTER_TUTORIAL_STEPS.findIndex(
    (step) => step.id === currentMasterTutorialStep.id,
  );
  const numberedMasterTutorialSteps = MASTER_TUTORIAL_STEPS.filter(
    (step) => step.id !== "welcome" && step.id !== "complete",
  );
  const numberedMasterTutorialIndex = numberedMasterTutorialSteps.findIndex(
    (step) => step.id === currentMasterTutorialStep.id,
  );
  const masterTutorialActionComplete = (() => {
    switch (masterTutorialStep) {
      case "lock":
        return masterEditable || lockedByOther;
      case "advanced-search":
        return advancedSearchOpen;
      case "filter":
        return filterOpen;
      case "add-edit":
        return showEditor;
      case "bulk-delete-a":
        return batchPanel === "a";
      case "bulk-delete-b":
        return batchPanel === "b";
      case "scoped-delete":
        return batchPanel === "scoped-b";
      case "history":
        return view === "history";
      default:
        return true;
    }
  })();
  const masterTutorialActionPending =
    !!currentMasterTutorialStep.requiresAction &&
    !masterTutorialActionComplete;
  const masterTutorialTargetSelector =
    masterTutorialStep === "merge" && !analysis
      ? '[data-tour="master-file-actions"]'
      : masterTutorialStep === "filter" && filterOpen
        ? '[data-tour="master-filter-panel"]'
        : masterTutorialStep === "add-edit" && showEditor
          ? '[data-tour="master-record-editor"]'
          : currentMasterTutorialStep.target ?? "";

  const prepareMasterTutorialStep = (step: MasterTutorialStep) => {
    if (
      [
        "search",
        "advanced-search",
        "filter",
        "quality",
        "records",
        "add-edit",
        "bulk-delete-a",
        "bulk-delete-b",
        "scoped-delete",
      ].includes(step)
    )
      setView("records");
    if (["history", "history-dates"].includes(step)) setView("history");
  };
  const openMasterTutorial = () => {
    setMasterTutorialStep("welcome");
    setMasterTutorialOpen(true);
  };
  const goToPreviousMasterTutorialStep = () => {
    if (currentMasterTutorialIndex <= 0) return;
    const previous = MASTER_TUTORIAL_STEPS[currentMasterTutorialIndex - 1];
    prepareMasterTutorialStep(previous.id);
    setMasterTutorialStep(previous.id);
  };
  const goToNextMasterTutorialStep = () => {
    if (masterTutorialStep === "welcome") {
      prepareMasterTutorialStep("lock");
      setMasterTutorialStep("lock");
      return;
    }
    const next = MASTER_TUTORIAL_STEPS[currentMasterTutorialIndex + 1];
    if (!next) return;
    if (masterTutorialStep === "advanced-search") setAdvancedSearchOpen(false);
    if (masterTutorialStep === "filter") setFilterOpen(false);
    if (masterTutorialStep === "add-edit" && showEditor && !editing)
      resetEditor();
    if (masterTutorialStep === "scoped-delete") setBatchPanel("");
    prepareMasterTutorialStep(next.id);
    setMasterTutorialStep(next.id);
  };

  useEffect(() => {
    if (!masterTutorialOpen) return;
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
    const frame = window.requestAnimationFrame(() => {
      if (!masterTutorialTargetSelector) return;
      target = document.querySelector(masterTutorialTargetSelector);
      if (!target) return;
      context = target.closest(
        ".master-hero, .master-lock-panel, .master-stats, .merge-review, .master-card",
      );
      if (context && context !== target)
        context.classList.add("request-tutorial-context");
      target.classList.add("request-tutorial-focus");
      target.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "center",
      });
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMasterTutorialOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", closeOnEscape);
      target?.classList.remove("request-tutorial-focus");
      context?.classList.remove("request-tutorial-context");
      document.body.classList.remove("request-tutorial-active");
    };
  }, [
    analysis,
    filterOpen,
    masterTutorialOpen,
    masterTutorialStep,
    masterTutorialTargetSelector,
    showEditor,
    view,
  ]);

  const renderRecordEditor = (inline = false) => {
    const editorBEntries = editableNumberEntries(bNumbersText);
    const editorBNumbers = editorBEntries.map((entry) => entry.value);
    const highlightedAon = editing
      ? matchingAon(editorBNumbers, query)
      : "";
    const invalidEditorA =
      Boolean(aNumber.trim()) && hasInvalidNumberLength(aNumber.trim());
    const invalidEditorB = invalidBNumbers(editorBNumbers);
    const invalidStartEditorA = hasInvalidNumberStart(aNumber);
    const invalidStartEditorB = invalidStartBNumbers(editorBNumbers);
    const allowedShortEditorAon = isSingleShortAon(editorBNumbers)
      ? editorBNumbers[0]
      : "";
    const invalidWhitespaceEditorA = hasInvalidNumberWhitespace(aNumber);
    const invalidWhitespaceEditorB = editorBEntries
      .filter((entry) => hasInvalidNumberWhitespace(entry.raw))
      .map((entry) => entry.raw);
    const showEditorBOverlay =
      Boolean(highlightedAon) ||
      invalidStartEditorB.length > 0 ||
      invalidEditorB.length > 0 ||
      invalidWhitespaceEditorB.length > 0;
    return (
    <div
      className={`master-editor ${inline ? "is-inline" : ""}`}
      data-tour={inline ? undefined : "master-record-editor"}
      ref={inline ? inlineEditorRef : undefined}
    >
      <div className="master-editor-heading">
        <div>
          <strong>
            {editing
              ? `Редактирование строки ${editing.lineNumber}`
              : "Новая строка"}
          </strong>
          <span>
            {editing
              ? `ID ${editing.id} · версия строки ${editing.version}`
              : "После сохранения строка получит постоянный ID"}
          </span>
        </div>
        <button type="button" onClick={resetEditor}>
          ×
        </button>
      </div>
      <div className="master-editor-grid">
        <label className="field">
          <span>Опорный номер</span>
          <input
            className={[
              invalidEditorA ? "is-invalid-number" : "",
              invalidStartEditorA ? "is-invalid-number-start" : "",
              invalidWhitespaceEditorA
                ? "is-invalid-number-whitespace"
                : "",
            ].filter(Boolean).join(" ")}
            value={aNumber}
            onChange={(event) => setANumber(event.target.value)}
            inputMode="numeric"
            placeholder="79000000001"
            disabled={!masterEditable}
          />
          {invalidEditorA && (
            <small className="number-length-warning">
              В опорном номере {aNumber.trim().length} символов вместо 11.
              Сохранение не заблокировано.
            </small>
          )}
          {invalidStartEditorA && (
            <small className="number-start-blocking-warning">
              Опорный номер {aNumber.trim()} начинается не с 7. Это только
              подсветка; сохранение разрешено.
            </small>
          )}
          {invalidWhitespaceEditorA && (
            <small className="number-whitespace-blocking-warning">
              В опорном номере есть пробел. Это только подсветка; сохранение
              разрешено.
            </small>
          )}
        </label>
        <label className="field master-b-field">
          <span>АОН</span>
          <div
            className={`master-highlighted-textarea ${
              showEditorBOverlay ? "has-highlight" : ""
            } ${invalidEditorB.length ? "has-invalid-number" : ""} ${
              invalidStartEditorB.length ? "has-invalid-number-start" : ""
            } ${
              invalidWhitespaceEditorB.length
                ? "has-invalid-number-whitespace"
                : ""
            }`}
          >
            {showEditorBOverlay && (
              <pre ref={editorBOverlayRef} aria-hidden="true">
                <HighlightedTextareaValue
                  value={bNumbersText}
                  query={query}
                  highlightInvalidNumbers
                  allowedShortAon={allowedShortEditorAon}
                />
              </pre>
            )}
            <textarea
              ref={editorBTextareaRef}
              className={showEditorBOverlay ? "has-aon-highlight" : ""}
              value={bNumbersText}
              onChange={(event) => setBNumbersText(event.target.value)}
              onScroll={(event) => {
                if (editorBOverlayRef.current)
                  editorBOverlayRef.current.scrollTop =
                    event.currentTarget.scrollTop;
              }}
              placeholder={"79100000001\n79100000002"}
              disabled={!masterEditable}
              spellCheck={false}
            />
          </div>
          <small>
            Если оставить пустым, в АОН будет записан опорный номер.
          </small>
          {allowedShortEditorAon && (
            <small className="short-aon-note">
              Единственный короткий АОН {allowedShortEditorAon} допустим и
              будет сформирован с маркером 4:2.
            </small>
          )}
          {!!invalidEditorB.length && (
            <small className="number-length-warning">
              АОН с длиной не 11 символов: {invalidEditorB.join(", ")}.
              Сохранение не заблокировано.
            </small>
          )}
          {!!invalidStartEditorB.length && (
            <small className="number-start-blocking-warning">
              АОН должны начинаться с 7: {invalidStartEditorB.join(", ")}.
              Это только подсветка; сохранение разрешено.
            </small>
          )}
          {!!invalidWhitespaceEditorB.length && (
            <small className="number-whitespace-blocking-warning">
              АОН содержат пробелы: {invalidWhitespaceEditorB.join(", ")}.
              Это только подсветка; сохранение разрешено.
            </small>
          )}
        </label>
        <MasterParameterEditor
          value={sourcePrefix}
          onChange={setSourcePrefix}
          disabled={!masterEditable}
        />
        <label className="field master-comment-field">
          <span>Комментарий к опорному номеру</span>
          <textarea
            value={comment}
            onChange={(event) => setComment(event.target.value.slice(0, 50000))}
            placeholder="Например: важное условие по этой связке"
            maxLength={50000}
            rows={3}
            disabled={!masterEditable}
          />
          <small>
            Комментарий хранится только в мастер-файле и будет заметен прямо
            в строке. {comment.length}/50000
          </small>
        </label>
      </div>
      <div className="master-editor-actions">
        <button
          className="secondary-button"
          type="button"
          onClick={resetEditor}
        >
          Отмена
        </button>
        <button
          className="primary-button"
          type="button"
          onClick={() => void saveRecord()}
          disabled={saving || !masterEditable}
        >
          {saving ? "Сохраняем…" : "Сохранить в master"}
        </button>
      </div>
    </div>
    );
  };

  const renderAonSearchReveal = (record: MasterRecord) => {
    const value = record.bNumbers.join("\n");
    const matchedAons = aonSearchMatchesByRecord.get(record.id) ?? [];
    const isPrimaryMatch = aonSearchMatch?.record.id === record.id;
    return (
      <div
        className="master-editor is-inline is-search-reveal"
        ref={isPrimaryMatch ? searchInlineEditorRef : undefined}
      >
        <div className="master-editor-heading">
          <div>
            <strong>
              Найдено АОН: {matchedAons.length}
            </strong>
            <span>
              Опорный номер {record.aNumber} раскрыт по результату поиска: {" "}
              {matchedAons.join(", ")}
            </span>
          </div>
        </div>
        <div className="master-editor-grid">
          <label className="field">
            <span>Опорный номер</span>
            <input value={record.aNumber} readOnly />
          </label>
          <label className="field master-b-field">
            <span>АОН</span>
            <div className="master-highlighted-textarea has-highlight">
              <pre ref={isPrimaryMatch ? searchBOverlayRef : undefined} aria-hidden="true">
                <HighlightedTextareaValue value={value} query={query} />
              </pre>
              <textarea
                ref={isPrimaryMatch ? searchBTextareaRef : undefined}
                className="has-aon-highlight"
                value={value}
                readOnly
                onScroll={(event) => {
                  if (isPrimaryMatch && searchBOverlayRef.current)
                    searchBOverlayRef.current.scrollTop =
                      event.currentTarget.scrollTop;
                }}
                spellCheck={false}
              />
            </div>
          </label>
          <label className="field master-parameter-field">
            <span>Параметр строки</span>
            <input value={record.sourcePrefix} readOnly />
          </label>
        </div>
      </div>
    );
  };

  const renderInvalidNumberReveal = (record: MasterRecord) => {
    const invalidAons = invalidBNumbers(record.bNumbers);
    return (
      <div className="master-invalid-reveal" role="status">
        <div className="master-invalid-reveal-heading">
          <div>
            <strong>Проверьте длину номеров</strong>
            <span>
              Подсветка носит информационный характер. Эти данные можно оставить
              без изменений.
            </span>
          </div>
          <span className="number-length-badge">
            {hasInvalidNumberLength(record.aNumber) ? "Опорный номер" : "АОН"}
          </span>
        </div>
        <div className="master-invalid-identity">
          <span>Опорный номер</span>
          <code
            className={
              hasInvalidNumberLength(record.aNumber)
                ? "is-invalid-number"
                : ""
            }
          >
            {record.aNumber}
          </code>
          {hasInvalidNumberLength(record.aNumber) && (
            <small>{record.aNumber.length} символов вместо 11</small>
          )}
        </div>
        <div className="master-invalid-aon-block">
          <strong>АОН внутри опорного номера</strong>
          <div className="master-invalid-aon-scroll">
            {record.bNumbers.map((number, index) => (
              <div
                className={
                  invalidAons.includes(number) ? "is-invalid-number" : ""
                }
                key={`${number}-${index}`}
              >
                <code>{number}</code>
                <span>
                  {invalidAons.includes(number)
                    ? `${number.length} символов вместо 11`
                    : isSingleShortAon(record.bNumbers)
                      ? "Допустимый короткий АОН · маркер 4:2"
                      : "11 символов"}
                </span>
              </div>
            ))}
          </div>
          {!!invalidAons.length && (
            <small>Требуют внимания: {invalidAons.length} АОН.</small>
          )}
        </div>
      </div>
    );
  };

  const renderInvalidStartReveal = (record: MasterRecord) => {
    const invalidAons = invalidStartBNumbers(record.bNumbers);
    return (
      <div className="master-invalid-reveal is-blocking-start" role="alert">
        <div className="master-invalid-reveal-heading">
          <div>
            <strong>Номера должны начинаться с 7</strong>
            <span>
              Все найденные значения только подсвечиваются. Строку можно
              сохранить без их исправления.
            </span>
          </div>
          <div className="master-invalid-reveal-actions">
            <span className="number-start-blocking-badge">
              Ошибок: {invalidAons.length + (hasInvalidNumberStart(record.aNumber) ? 1 : 0)}
            </span>
            <button
              className="primary-button compact"
              type="button"
              onClick={() => void openInvalidRecordForEdit(record)}
              disabled={lockedByOther || lockChanging}
            >
              {lockedByOther ? "Мастер-файл занят" : "Исправить номера"}
            </button>
          </div>
        </div>
        {hasInvalidNumberStart(record.aNumber) && (
          <div className="master-invalid-identity">
            <span>Опорный номер</span>
            <code className="is-invalid-number-start">{record.aNumber}</code>
            <small>Должен начинаться с 7</small>
          </div>
        )}
        {!!invalidAons.length && (
          <div className="master-invalid-aon-block">
            <strong>АОН внутри опорного номера</strong>
            <div className="master-invalid-aon-scroll">
              {invalidAons.map((number, index) => (
                <div className="is-invalid-number-start" key={`${number}-${index}`}>
                  <code>{number}</code>
                  <span>Должен начинаться с 7</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <main className="app-shell">
      <AppHeader onBeforeNavigate={releaseMasterForNavigation} />

      {!masterTutorialOpen && (
        <button
          className="request-tutorial-launcher"
          type="button"
          onClick={openMasterTutorial}
          aria-label="Открыть обучение по работе с мастер-файлом"
        >
          <span aria-hidden="true">?</span>
          <span>
            <strong>Обучение</strong>
            <small>Мастер-файл</small>
          </span>
        </button>
      )}

      {masterTutorialOpen && (
        <div
          className="request-tutorial-layer"
          data-tutorial-step={`master-${masterTutorialStep}`}
        >
          <div className="request-tutorial-backdrop" aria-hidden="true" />
          <aside
            className="request-tutorial-coach master-tutorial-coach"
            role="region"
            aria-labelledby="master-tutorial-title"
            aria-describedby="master-tutorial-description"
          >
            <div className="request-tutorial-coach-header">
              <div className="request-tutorial-assistant">
                <span aria-hidden="true">t2</span>
                <div>
                  <strong>Помощник по обучению</strong>
                  <small>Работа с мастер-файлом</small>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setMasterTutorialOpen(false)}
                aria-label="Выйти из обучения мастер-файлу"
              >
                ×
              </button>
            </div>
            <div className="request-tutorial-progress-row">
              <span>
                {masterTutorialStep === "welcome"
                  ? "Вводная сессия"
                  : masterTutorialStep === "complete"
                    ? "Обучение завершено"
                    : `Шаг ${numberedMasterTutorialIndex + 1} из ${numberedMasterTutorialSteps.length}`}
              </span>
              {numberedMasterTutorialIndex >= 0 && (
                <strong>
                  {Math.round(
                    ((numberedMasterTutorialIndex + 1) /
                      numberedMasterTutorialSteps.length) *
                      100,
                  )}
                  %
                </strong>
              )}
            </div>
            {numberedMasterTutorialIndex >= 0 && (
              <div
                className="request-tutorial-progress"
                role="progressbar"
                aria-label="Прогресс обучения мастер-файлу"
                aria-valuemin={1}
                aria-valuemax={numberedMasterTutorialSteps.length}
                aria-valuenow={numberedMasterTutorialIndex + 1}
              >
                <span
                  style={{
                    width: `${
                      ((numberedMasterTutorialIndex + 1) /
                        numberedMasterTutorialSteps.length) *
                      100
                    }%`,
                  }}
                />
              </div>
            )}
            <div className="request-tutorial-copy">
              <h2 id="master-tutorial-title">
                {currentMasterTutorialStep.title}
              </h2>
              <p id="master-tutorial-description">
                {currentMasterTutorialStep.description}
              </p>
              <div className="request-tutorial-action">
                <span aria-hidden="true">→</span>
                <p>{currentMasterTutorialStep.action}</p>
              </div>
              {masterTutorialActionPending && (
                <div className="request-tutorial-wait" role="status">
                  <span aria-hidden="true" />
                  Ожидаю выполнения выделенного действия
                </div>
              )}
              {!!currentMasterTutorialStep.requiresAction &&
                masterTutorialActionComplete && (
                <div className="request-tutorial-done" role="status">
                  <span aria-hidden="true">✓</span>
                  Действие выполнено. Проверьте результат и нажмите «Далее».
                </div>
              )}
            </div>
            <div className="request-tutorial-actions">
              <button
                className="request-tutorial-exit"
                type="button"
                onClick={() => setMasterTutorialOpen(false)}
              >
                Выйти из обучения
              </button>
              <div>
                {masterTutorialStep !== "welcome" && (
                  <button
                    className="secondary-button compact"
                    type="button"
                    onClick={goToPreviousMasterTutorialStep}
                  >
                    Назад
                  </button>
                )}
                <button
                  className="primary-button compact"
                  type="button"
                  onClick={
                    masterTutorialStep === "complete"
                      ? () => setMasterTutorialOpen(false)
                      : goToNextMasterTutorialStep
                  }
                  disabled={masterTutorialActionPending}
                >
                  {masterTutorialStep === "welcome"
                    ? "Начать обучение"
                    : masterTutorialStep === "complete"
                      ? "Готово"
                      : masterTutorialActionPending
                        ? "Выполните действие"
                        : "Далее"}
                </button>
              </div>
            </div>
          </aside>
        </div>
      )}

      <div className="workspace master-workspace">
        <section className="master-hero">
          <div>
            <p className="eyebrow">Единый источник данных</p>
            <h1>Мастер файл</h1>
            <p>
              Стабильные ID строк, версии и полный журнал изменений. Файл CSV
              или Excel сначала сравнивается с текущей базой и применяется
              только после согласования конфликтов.
            </p>
          </div>
          <div className="master-hero-actions" data-tour="master-file-actions">
            <input
              ref={fileInputRef}
              type="file"
              accept={MASTER_IMPORT_ACCEPT}
              hidden
              onChange={analyzeFile}
            />
            {user?.voiceAdmin && (
              <button
                className="secondary-button master-reset-history-button"
                type="button"
                onClick={() => setResetHistoryDialogOpen(true)}
                disabled={
                  (recordStats.revision === 0 && historyTotal === 0) ||
                  !masterEditable ||
                  resettingHistory ||
                  clearingMaster ||
                  uploading ||
                  merging ||
                  saving
                }
                title={
                  !masterEditable
                    ? "Сначала займите мастер-файл"
                    : recordStats.revision === 0 && historyTotal === 0
                      ? "Журнал уже пуст, версия T2-0"
                      : undefined
                }
              >
                Очистить журнал и обнулить версию
              </button>
            )}
            {user?.voiceAdmin && (
              <button
                className="danger-button master-clear-button"
                type="button"
                onClick={() => setClearDialogOpen(true)}
                disabled={
                  !recordStats.activeCount ||
                  !masterEditable ||
                  clearingMaster ||
                  uploading ||
                  merging ||
                  saving
                }
                title={
                  !masterEditable
                    ? "Сначала займите мастер-файл"
                    : !recordStats.activeCount
                      ? "Мастер-файл уже пуст"
                      : undefined
                }
              >
                Очистить мастер-файл
              </button>
            )}
            <button
              className="secondary-button"
              type="button"
              onClick={() => void downloadMaster()}
              disabled={!recordStats.activeCount || !masterEditable}
              title={
                masterEditable
                  ? undefined
                  : "Сначала займите мастер-файл"
              }
            >
              Скачать master.csv
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || merging || !masterEditable}
              title={
                masterEditable
                  ? undefined
                  : "Сначала займите мастер-файл"
              }
            >
              {uploading ? "Проверяем файл…" : "Загрузить файл для слияния"}
            </button>
          </div>
        </section>

        {uploading && (
          <section className="card merge-progress" aria-live="polite">
            <strong>
              {importProgress
                ? importProgressLabel(importProgress)
                : "Загружаем файл на сервер"}
            </strong>
            <span>
              {importProgress
                ? `${importProgress.progressRows.toLocaleString("ru-RU")} строк обработано. Можно обновить страницу — сервер продолжит работу, а прогресс восстановится автоматически.`
                : "Не закрывайте вкладку до завершения передачи файла. После передачи анализ продолжится на сервере и переживёт обновление страницы."}
            </span>
          </section>
        )}

        <section
          className={`master-lock-panel ${
            masterEditable
              ? "is-owned"
              : needsReclaim
                ? "is-stale-session"
                : lockedByOther
                  ? "is-locked"
                  : "is-free"
          }`}
          aria-live="polite"
          data-tour="master-lock-panel"
        >
          <div className="master-lock-status" aria-hidden="true">
            <span>
              {masterEditable ? "✓" : needsReclaim ? "↻" : lockedByOther ? "⌁" : "○"}
            </span>
          </div>
          <div className="master-lock-copy">
            <strong>
              {lockLoading
                ? "Проверяем доступность мастер-файла…"
                : masterEditable
                  ? "Мастер-файл занят вами"
                  : needsReclaim
                    ? "Мастер-файл занят вами в другой вкладке"
                    : lockedByOther
                      ? "Мастер-файл занят другим пользователем"
                      : "Мастер-файл свободен"}
            </strong>
            <span>
              {masterEditable
                ? "Редактирование, импорт и экспорт доступны только вам до освобождения файла."
                : needsReclaim
                  ? "Нажмите «Перехватить», чтобы продолжить редактирование здесь. Другая вкладка перейдёт в режим просмотра."
                  : lockedByOther
                    ? `Редактирование заблокировано. Владелец: ${masterLock.owner?.email ?? "неизвестный пользователь"}.`
                    : "Займите мастер-файл, чтобы импортировать, экспортировать или изменять данные."}
              {masterLock.acquiredAt
                ? ` Занят ${formatDate(masterLock.acquiredAt)}.`
                : ""}
            </span>
          </div>
          <button
            className={
              masterEditable ? "secondary-button" : "primary-button"
            }
            type="button"
            data-tour="master-lock"
            onClick={() =>
              void (lockedByOther ? notifyLockOwner() : toggleMasterLock())
            }
            disabled={
              lockLoading ||
              lockChanging ||
              notifyingLockOwner ||
              uploading ||
              merging ||
              saving
            }
          >
            {lockChanging
              ? "Сохраняем…"
              : masterEditable
                ? "Освободить мастер-файл"
                : needsReclaim
                  ? "Перехватить"
                  : lockedByOther
                    ? notifyingLockOwner
                      ? "Отправляем напоминание…"
                      : "Уведомить владельца"
                    : "Занять мастер-файл"}
          </button>
        </section>

        <div className="master-stats" data-tour="master-stats">
          <div>
            <span>Текущая версия</span>
            <strong>{masterVersion(recordStats.revision)}</strong>
          </div>
          <div>
            <span>Активных строк</span>
            <strong>{recordStats.activeCount.toLocaleString("ru-RU")}</strong>
          </div>
          <div>
            <span>Всего АОН</span>
            <strong>{recordStats.totalB.toLocaleString("ru-RU")}</strong>
          </div>
          <div>
            <span>Изменений в журнале</span>
            <strong>{historyTotal.toLocaleString("ru-RU") || "—"}</strong>
          </div>
        </div>

        {error && (
          <div className="master-alert is-error" role="alert">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
            {needsReclaim && (
              <button
                className="primary-button"
                type="button"
                disabled={lockChanging}
                onClick={() => void toggleMasterLock()}
              >
                {lockChanging ? "Сохраняем…" : "Перехватить"}
              </button>
            )}
            <button type="button" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {warning && (
          <div className="master-alert is-warning" role="status">
            <strong>Обратите внимание</strong>
            <span>{warning}</span>
            <button type="button" onClick={() => setWarning("")}>
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="master-alert is-success" role="status">
            <strong>Готово</strong>
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice("")}>
              ×
            </button>
          </div>
        )}
        {recordStats.shortAonRecordCount > 0 && (
          <div className="master-number-warning is-short-aon" role="status">
            <div>
              <strong>Опорные номера с коротким АОН</strong>
              <span>
                Найдено строк: {recordStats.shortAonRecordCount}. Единственный
                АОН длиной 3–5 символов считается допустимым и формируется с
                маркером 4:2.
              </span>
            </div>
            <button
              className={`secondary-button compact ${
                shortAonOnly ? "is-active-filter" : ""
              }`}
              type="button"
              onClick={showShortAonRecords}
            >
              {shortAonOnly
                ? `Показаны короткие АОН · ${recordStats.total}`
                : `Показать опорные с коротким номером · ${recordStats.shortAonRecordCount}`}
            </button>
          </div>
        )}
        {recordStats.invalidStartRecordCount > 0 && (
          <div className="master-number-warning is-blocking" role="alert">
            <div>
              <strong>Найдены номера, которые начинаются не с 7</strong>
              <span>
                Опорных номеров: {recordStats.invalidStartANumberCount}; АОН: {" "}
                {recordStats.invalidStartBNumberCount}. Эти значения только
                подсвечиваются и не блокируют сохранение или слияние.
              </span>
            </div>
            <button
              className={`secondary-button compact ${
                invalidStartOnly ? "is-active-filter" : ""
              }`}
              type="button"
              onClick={() => void showNextInvalidStart()}
            >
              {invalidStartOnly
                ? `Следующий номер не с 7 ${
                    (invalidStartCursor % Math.max(invalidStartRecords.length, 1)) + 1
                  }/${recordStats.invalidStartRecordCount}`
                : `Показать номера не с 7 · ${recordStats.invalidStartRecordCount}`}
            </button>
          </div>
        )}
        {recordStats.invalidRecordCount > 0 && (
          <div className="master-number-warning" role="status">
            <div>
              <strong>Найдены номера с длиной не 11 символов</strong>
              <span>
                Опорных номеров: {recordStats.invalidANumberCount}; АОН:{" "}
                {recordStats.invalidBNumberCount}. Приложение только предупреждает
                и не изменяет данные автоматически.
              </span>
            </div>
            <button
              className={`secondary-button compact ${
                invalidOnly ? "is-active-filter" : ""
              }`}
              type="button"
              onClick={() => void showNextInvalidNumber()}
            >
              {invalidOnly
                ? `Следующий некорректный номер ${
                    (invalidCursor % Math.max(invalidRecords.length, 1)) + 1
                  }/${recordStats.invalidRecordCount}`
                : `Показать некорректные номера · ${recordStats.invalidRecordCount}`}
            </button>
          </div>
        )}

        {analysis && (
          <section
            className="card merge-review"
            aria-labelledby="merge-title"
            data-tour="master-merge-review"
          >
            <div className="merge-review-heading">
              <div>
                <p className="eyebrow">Предложение на слияние</p>
                <h2 id="merge-title">{analysis.sourceName}</h2>
                <p>
                  Сравнение выполнено с версией{" "}
                  {masterVersion(analysis.baseRevision)}.
                  Отсутствующие в CSV master‑строки не удаляются.
                </p>
              </div>
              <button
                className="text-button"
                type="button"
                onClick={() => setImportAnalysis(null)}
              >
                Отменить импорт
              </button>
            </div>
            <div className="merge-stats">
              <div className="is-new">
                <span>Новые</span>
                <strong>{analysis.stats.new}</strong>
                <small>будут добавлены</small>
              </div>
              <div className="is-same">
                <span>Без изменений</span>
                <strong>{analysis.stats.unchanged}</strong>
                <small>слияние не требуется</small>
              </div>
              <div
                className={
                  analysis.stats.conflict > 0
                    ? "is-conflict"
                    : "is-same"
                }
              >
                <span>Конфликты</span>
                <strong>{analysis.stats.conflict}</strong>
                <small>
                  {analysis.stats.conflict > 0
                    ? "нужно выбрать версию"
                    : "не обнаружены"}
                </small>
              </div>
              <div>
                <span>Только в master</span>
                <strong>{analysis.stats.masterOnly}</strong>
                <small>останутся без изменений</small>
              </div>
            </div>

            <div className="merge-source-summary" role="status">
              Прочитано строк: {analysis.stats.sourceRows.toLocaleString("ru-RU")};
              сохранено для загрузки: {preservedImportRows.toLocaleString("ru-RU")};
              уникальных опорных номеров: {analysis.stats.uniqueA.toLocaleString("ru-RU")};
              повторных строк сохранено отдельно: {analysis.stats.duplicateA.toLocaleString("ru-RU")};
              некорректных строк пропущено: {analysis.stats.invalidRows.toLocaleString("ru-RU")}
              {analysis.stats.skippedRows > 0
                ? `; пустых строк пропущено: ${analysis.stats.skippedRows.toLocaleString("ru-RU")}`
                : ""}.
            </div>

            {analysis.stats.invalidRows > 0 && (
              <div className="merge-warning">
                {analysis.stats.invalidRows} некорректных строк CSV пропущено.
                Проверьте файл перед слиянием.
              </div>
            )}

            {mergeNumberStartWarnings.length > 0 && (
              <div className="merge-warning" role="status">
                <strong>Подсвечены номера, которые начинаются не с 7</strong>
                <span>
                  Это предупреждение не блокирует слияние. Найдено: {" "}
                  {mergeNumberStartWarnings.length}.
                </span>
                <div className="merge-number-error-list">
                  {mergeNumberStartWarnings.map((item, index) => (
                    <code key={`${item.itemId}-${item.kind}-${item.number}-${index}`}>
                      Строка CSV {item.sourceRow}: {item.kind === "a"
                        ? `опорный номер ${item.number}`
                        : `АОН ${item.number} у опорного ${item.aNumber}`}
                    </code>
                  ))}
                </div>
              </div>
            )}

            {!!duplicatePreviewItems.length && (
              <div className="duplicate-review">
                <div className="duplicate-review-heading">
                  <div>
                    <strong>
                      Найдены дубликаты опорных номеров
                    </strong>
                    <span>
                      Групп: {analysis.stats.duplicateGroups}; повторных строк:{" "}
                      {analysis.stats.duplicateA}. Каждая строка будет загружена
                      в master отдельно.
                    </span>
                  </div>
                  <div className="duplicate-review-actions">
                    <button
                      className="primary-button compact"
                      type="button"
                      aria-pressed
                      disabled
                    >
                      Добавить отдельными строками
                    </button>
                    <button
                      className="secondary-button compact"
                      type="button"
                      onClick={() => void showNextAnalysisDuplicate()}
                    >
                      Показать дубликат{" "}
                      {(analysisDuplicateCursor %
                        duplicatePreviewItems.length) +
                        1}
                      /{analysis.stats.duplicateGroups}
                    </button>
                  </div>
                </div>
                <p className="duplicate-merge-decision" role="status">
                  При подтверждении будут загружены все{" "}
                  {preservedImportRows.toLocaleString("ru-RU")} корректных
                  строк без автоматического объединения.
                </p>
                <div
                  className="duplicate-review-list"
                  onScroll={(event) => {
                    const element = event.currentTarget;
                    if (
                      duplicatePreviewHasMore &&
                      !duplicatePreviewLoading &&
                      element.scrollTop + element.clientHeight >=
                        element.scrollHeight - 80
                    )
                      void loadDuplicatePreviewPage();
                  }}
                >
                  {duplicatePreviewItems.map((duplicate) => (
                    <article
                      key={duplicate.aNumber}
                      ref={(node) => {
                        if (node)
                          analysisDuplicateRefs.current.set(
                            duplicate.aNumber,
                            node,
                          );
                        else
                          analysisDuplicateRefs.current.delete(
                            duplicate.aNumber,
                          );
                      }}
                    >
                      <span>Повторяющийся опорный номер</span>
                      <strong
                        className={
                          hasInvalidNumberLength(duplicate.aNumber)
                            ? "is-invalid-number"
                            : ""
                        }
                      >
                        {duplicate.aNumber}
                      </strong>
                      <small>
                        Строки исходного файла:{" "}
                        {duplicate.sourceRows.join(", ")}
                      </small>
                    </article>
                  ))}
                  {(duplicatePreviewLoading || duplicatePreviewHasMore) && (
                    <div className="new-record-page-status duplicate-page-status">
                      {duplicatePreviewLoading
                        ? "Загружаем следующие 200 групп…"
                        : `Показано ${duplicatePreviewItems.length} из ${analysis.stats.duplicateGroups}`}
                      {!duplicatePreviewLoading && duplicatePreviewHasMore && (
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => void loadDuplicatePreviewPage()}
                        >
                          Загрузить следующие 200
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {conflictItems.length > 0 && (
              <div className="conflict-list">
                <div className="conflict-list-heading">
                  <div>
                    <strong>Согласование конфликтов</strong>
                    <span>
                      По умолчанию сохраняется версия из master. Отметьте
                      изменения, которые нужно применить из CSV. Если опорный
                      номер и параметр совпадают, новые АОН добавятся к уже
                      существующим без удаления.
                    </span>
                  </div>
                  <label
                    className={`master-check master-replace-all ${
                      replaceAll ? "is-active" : ""
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={replaceAll}
                      disabled={!masterEditable}
                      onChange={(event) => {
                        setReplaceAll(event.target.checked);
                        setSelectedConflicts([]);
                      }}
                    />
                    <span>
                      <strong>Применить все конфликты</strong>
                      <small>Дополнить АОН и применить остальные изменения CSV</small>
                    </span>
                  </label>
                </div>
                <div
                  className="conflict-scroll-window"
                  onScroll={(event) => {
                    const element = event.currentTarget;
                    if (
                      conflictPreviewHasMore &&
                      !conflictPreviewLoading &&
                      element.scrollTop + element.clientHeight >=
                        element.scrollHeight - 100
                    )
                      void loadConflictPreviewPage();
                  }}
                >
                {conflictItems.map((item) => {
                  const selected =
                    replaceAll || selectedConflicts.includes(item.id);
                  const addsAons = conflictAddsAons(item);
                  const additionalAonCount = conflictAdditionalAonCount(item);
                  return (
                    <article
                      className={`conflict-row ${selected ? "is-selected" : ""} ${
                        recordHasInvalidNumbers(item.incoming) ||
                        (item.current && recordHasInvalidNumbers(item.current))
                          ? "has-invalid-number"
                          : ""
                      } ${
                        recordHasInvalidNumberStart(item.incoming)
                          ? "has-invalid-number-start"
                          : ""
                      }`}
                      key={item.id}
                    >
                      <div className="conflict-identity">
                        <span>Строка CSV {item.sourceRow}</span>
                        <strong
                          className={[
                            hasInvalidNumberLength(item.aNumber)
                              ? "is-invalid-number"
                              : "",
                            hasInvalidNumberStart(item.aNumber)
                              ? "is-invalid-number-start"
                              : "",
                          ].filter(Boolean).join(" ")}
                        >
                          {item.aNumber}
                        </strong>
                        <small>ID {item.current?.id}</small>
                      </div>
                      <div className="conflict-version">
                        <span className="version-label">Сейчас в master</span>
                        <div className="number-chips">
                          {item.current?.bNumbers.map((number) => (
                            <code
                              className={aonNumberClass(
                                number,
                                item.current?.bNumbers ?? [],
                              )}
                              key={number}
                            >
                              {number}
                            </code>
                          ))}
                        </div>
                        <small>
                          Параметр: {item.current?.sourcePrefix}
                        </small>
                      </div>
                      <div className="conflict-arrow" aria-hidden="true">
                        →
                      </div>
                      <div className="conflict-version">
                        <span className="version-label">Версия из CSV</span>
                        <div className="number-chips">
                          {item.incoming.bNumbers.map((number) => (
                            <code
                              className={aonNumberClass(
                                number,
                                item.incoming.bNumbers,
                              )}
                              key={number}
                            >
                              {number}
                            </code>
                          ))}
                        </div>
                        <small>
                          Параметр: {item.incoming.sourcePrefix}
                        </small>
                        {addsAons && (
                          <small className="conflict-additive-note">
                            Будет добавлено новых АОН: {additionalAonCount}.
                            Текущие АОН сохранятся.
                          </small>
                        )}
                        {hasInvalidNumberStart(item.incoming.aNumber) && (
                          <small className="number-start-blocking-warning">
                            Опорный номер в версии из CSV начинается не с 7.
                            Это только подсветка; изменение можно подтвердить.
                          </small>
                        )}
                        {!!invalidStartBNumbers(item.incoming.bNumbers).length && (
                          <small className="number-start-blocking-warning">
                            АОН не с 7 подсвечены. Выбранное изменение можно слить
                            без исправления.
                          </small>
                        )}
                      </div>
                      <label className="replace-choice">
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={replaceAll || !masterEditable}
                          onChange={(event) =>
                            setSelectedConflicts((current) =>
                              event.target.checked
                                ? [...current, item.id]
                                : current.filter((id) => id !== item.id),
                            )
                          }
                        />
                        {selected
                          ? addsAons
                            ? "Дополнить master"
                            : "Применить CSV"
                          : "Оставить master"}
                      </label>
                    </article>
                  );
                })}
                <div className="new-record-page-status">
                  {conflictPreviewLoading
                    ? "Загружаем следующие 200 конфликтов…"
                    : `Показано ${conflictItems.length} из ${analysis.stats.conflict}`}
                  {!conflictPreviewLoading && conflictPreviewHasMore && (
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => void loadConflictPreviewPage()}
                    >
                      Загрузить следующие 200
                    </button>
                  )}
                </div>
                </div>
                {conflictPreviewHasMore && (
                  <p className="merge-preview-note">
                    Показана часть отличий. Действие «Применить все конфликты»
                    применяется ко всему файлу, включая скрытые строки.
                  </p>
                )}
              </div>
            )}

            {analysis.stats.new > 0 && (
              <details
                className="new-record-preview"
                open={newPreviewOpen}
                onToggle={(event) => {
                  const open = event.currentTarget.open;
                  setNewPreviewOpen(open);
                  if (open && !newPreviewItems.length)
                    void loadNewPreviewPage(true);
                }}
              >
                <summary>
                  Показать новые строки ({analysis.stats.new})
                </summary>
                <div
                  className="new-record-preview-list"
                  onScroll={(event) => {
                    const element = event.currentTarget;
                    if (
                      newPreviewHasMore &&
                      !newPreviewLoading &&
                      element.scrollTop + element.clientHeight >=
                        element.scrollHeight - 80
                    )
                      void loadNewPreviewPage();
                  }}
                >
                  {newPreviewItems.map((item) => {
                    const editingItem = editingImportItemId === item.id;
                    const importEditBEntries = editingItem
                      ? editableNumberEntries(importEditBNumbers)
                      : [];
                    const importEditorBNumbers = importEditBEntries.map(
                      (entry) => entry.value,
                    );
                    const importInvalidStartBNumbers = editingItem
                      ? invalidStartBNumbers(importEditorBNumbers)
                      : [];
                    const importInvalidLengthBNumbers = editingItem
                      ? invalidBNumbers(importEditorBNumbers)
                      : [];
                    const importAllowedShortAon = isSingleShortAon(
                      importEditorBNumbers,
                    )
                      ? importEditorBNumbers[0]
                      : "";
                    const importWhitespaceBNumbers = editingItem
                      ? importEditBEntries
                          .filter((entry) =>
                            hasInvalidNumberWhitespace(entry.raw),
                          )
                          .map((entry) => entry.raw)
                      : [];
                    const importHasHighlightedBNumbers =
                      importInvalidStartBNumbers.length > 0 ||
                      importInvalidLengthBNumbers.length > 0 ||
                      importWhitespaceBNumbers.length > 0;
                    return (
                      <article
                        className={`new-record-row ${
                          recordHasInvalidNumbers(item.incoming)
                            ? "has-invalid-number"
                            : ""
                        } ${
                          recordHasInvalidNumberStart(item.incoming)
                            ? "has-invalid-number-start"
                            : ""
                        }`}
                        key={item.id}
                      >
                        <div className="new-record-row-heading">
                          <div>
                            <span>Строка CSV {item.sourceRow}</span>
                            <strong
                              className={[
                                hasInvalidNumberLength(item.incoming.aNumber)
                                  ? "is-invalid-number"
                                  : "",
                                hasInvalidNumberStart(item.incoming.aNumber)
                                  ? "is-invalid-number-start"
                                  : "",
                              ].filter(Boolean).join(" ")}
                            >
                              {item.incoming.aNumber}
                            </strong>
                            <small>
                              АОН: {item.incoming.bNumbers.length} · параметр:{" "}
                              {item.incoming.sourcePrefix}
                            </small>
                            {recordHasInvalidNumbers(item.incoming) && (
                              <small className="number-length-warning">
                                Есть номера с длиной не 11 символов. Слияние не
                                блокируется этим предупреждением.
                              </small>
                            )}
                            {recordHasInvalidNumberStart(item.incoming) && (
                              <small className="number-start-blocking-warning">
                                {hasInvalidNumberStart(item.incoming.aNumber)
                                  ? `Опорный номер ${item.incoming.aNumber} должен начинаться с 7. `
                                  : ""}
                                {invalidStartBNumbers(item.incoming.bNumbers).length
                                  ? `АОН не с 7: ${invalidStartBNumbers(item.incoming.bNumbers).join(", ")}. Слияние разрешено.`
                                  : ""}
                              </small>
                            )}
                          </div>
                          {!editingItem && (
                            <button
                              className="secondary-button compact"
                              type="button"
                              onClick={() => startImportItemEdit(item)}
                              disabled={!masterEditable}
                            >
                              Редактировать
                            </button>
                          )}
                        </div>

                        {editingItem ? (
                          <div className="new-record-editor">
                            <label className="field">
                              <span>Опорный номер</span>
                              <input
                                className={
                                  hasInvalidNumberWhitespace(importEditANumber)
                                    ? "is-invalid-number-whitespace"
                                    : ""
                                }
                                value={importEditANumber}
                                onChange={(event) =>
                                  setImportEditANumber(event.target.value)
                                }
                                inputMode="numeric"
                                disabled={savingImportItem || !masterEditable}
                              />
                              {hasInvalidNumberWhitespace(
                                importEditANumber,
                              ) && (
                                <small className="number-whitespace-blocking-warning">
                                  В опорном номере есть пробел. Это только
                                  подсветка; сохранение разрешено.
                                </small>
                              )}
                            </label>
                            <label className="field">
                              <span>АОН — по одному в строке</span>
                              <div
                                className={[
                                  "master-highlighted-textarea",
                                  importHasHighlightedBNumbers
                                    ? "has-highlight"
                                    : "",
                                  importInvalidStartBNumbers.length
                                    ? "has-invalid-number-start"
                                    : "",
                                  importInvalidLengthBNumbers.length
                                    ? "has-invalid-number"
                                    : "",
                                  importWhitespaceBNumbers.length
                                    ? "has-invalid-number-whitespace"
                                    : "",
                                ]
                                  .filter(Boolean)
                                  .join(" ")}
                              >
                                {importHasHighlightedBNumbers && (
                                  <pre ref={importBOverlayRef} aria-hidden="true">
                                    <HighlightedTextareaValue
                                      value={importEditBNumbers}
                                      query=""
                                      highlightInvalidNumbers
                                      allowedShortAon={importAllowedShortAon}
                                    />
                                  </pre>
                                )}
                                <textarea
                                  ref={importBTextareaRef}
                                  className={
                                    importHasHighlightedBNumbers
                                      ? "has-aon-highlight"
                                      : ""
                                  }
                                  value={importEditBNumbers}
                                  onChange={(event) =>
                                    setImportEditBNumbers(event.target.value)
                                  }
                                  onScroll={(event) => {
                                    if (importBOverlayRef.current)
                                      importBOverlayRef.current.scrollTop =
                                        event.currentTarget.scrollTop;
                                  }}
                                  disabled={
                                    savingImportItem || !masterEditable
                                  }
                                />
                              </div>
                              {importHasHighlightedBNumbers && (
                                <small className="number-start-blocking-warning">
                                  Красным выделены АОН не с 7, оранжевым — АОН
                                  с длиной не 11 символов, фиолетовым — АОН с
                                  пробелами. Все эти предупреждения не блокируют
                                  сохранение.
                                </small>
                              )}
                            </label>
                            <MasterParameterEditor
                              value={importEditSourcePrefix}
                              onChange={setImportEditSourcePrefix}
                              disabled={savingImportItem || !masterEditable}
                            />
                            <div className="new-record-editor-actions">
                              <button
                                className="secondary-button compact"
                                type="button"
                                onClick={cancelImportItemEdit}
                                disabled={savingImportItem}
                              >
                                Отмена
                              </button>
                              <button
                                className="primary-button compact"
                                type="button"
                                onClick={() => void saveImportItem(item)}
                                disabled={
                                  savingImportItem || !masterEditable
                                }
                              >
                                {savingImportItem
                                  ? "Сохраняем…"
                                  : "Сохранить строку"}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="new-record-full">
                            <span>Полная строка записи</span>
                            <code>{formattedImportLine(item.incoming)}</code>
                          </div>
                        )}
                      </article>
                    );
                  })}
                  {newPreviewLoading && (
                    <div className="new-record-page-status">
                      Загружаем следующие 200 строк…
                    </div>
                  )}
                  {!newPreviewLoading && newPreviewItems.length > 0 && (
                    <div className="new-record-page-status">
                      Показано {newPreviewItems.length} из{" "}
                      {analysis.stats.new}
                      {newPreviewHasMore && (
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => void loadNewPreviewPage()}
                        >
                          Загрузить следующие 200
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </details>
            )}

            <div className="merge-footer">
              <div>
                <strong>
                  Будет создана одна новая версия с полным списком изменений
                </strong>
                <small>
                  Новых строк: {analysis.stats.new}; применяемых конфликтов:
                  {replaceAll
                    ? ` ${analysis.stats.conflict}`
                    : ` ${selectedConflicts.length}`}
                </small>
              </div>
              <button
                className="primary-button"
                type="button"
                onClick={() => void mergeImport()}
                disabled={
                  merging ||
                  !masterEditable
                }
              >
                {merging ? "Выполняем слияние…" : "Подтвердить слияние"}
              </button>
            </div>
          </section>
        )}

        <section className="card master-card" data-tour="master-records-panel">
          <div className="master-toolbar">
            <div
              className="master-tabs"
              role="tablist"
              data-tour="master-tabs"
            >
              <button
                className={view === "records" ? "is-active" : ""}
                type="button"
                role="tab"
                aria-selected={view === "records"}
                onClick={() => setView("records")}
              >
                Текущая база
              </button>
              <button
                className={view === "history" ? "is-active" : ""}
                type="button"
                role="tab"
                aria-selected={view === "history"}
                onClick={() => setView("history")}
              >
                История изменений
              </button>
            </div>
            <div
              className={`master-search-shell ${advancedSearchOpen ? "is-advanced" : ""}`}
              data-tour="master-search"
            >
              <label className="master-search">
                <span aria-hidden="true">⌕</span>
                {advancedSearchOpen && view === "records" ? (
                  <textarea
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={"Вставьте часть или полную строку\nлибо несколько опорных номеров или АОН"}
                    rows={4}
                    spellCheck={false}
                  />
                ) : (
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={
                      view === "records"
                        ? "Найти по номеру, ID, части или полной строке"
                        : "Найти по опорному номеру, АОН, ID или файлу"
                    }
                  />
                )}
              </label>
              {view === "records" && (
                <div className="master-search-mode">
                  <button
                    type="button"
                    data-tour="master-advanced-search"
                    onClick={() => setAdvancedSearchOpen((current) => !current)}
                  >
                    {advancedSearchOpen ? "Обычный поиск" : "Расширенный поиск"}
                  </button>
                  {advancedSearchOpen && (
                    <small>
                      Поиск находит совпадение в любом месте полной строки.
                      Несколько номеров можно указать через пробел, запятую,
                      точку с запятой или с новой строки.
                    </small>
                  )}
                </div>
              )}
            </div>
            {view === "records" && (
              <div
                className="master-toolbar-actions"
                data-tour="master-quality-tools"
              >
                <button
                  className={`secondary-button compact ${
                    activeFilterCount ? "is-active-filter" : ""
                  }`}
                  type="button"
                  data-tour="master-filter-toggle"
                  aria-expanded={filterOpen}
                  onClick={() => setFilterOpen((current) => !current)}
                >
                  Фильтр
                  {activeFilterCount ? ` · ${activeFilterCount}` : ""}
                </button>
                <button
                  className={`secondary-button compact ${
                    allFilteredRecordsSelected ? "is-active-filter" : ""
                  }`}
                  type="button"
                  disabled={!recordStats.total || !!bulkDeleting}
                  onClick={toggleAllFilteredRecords}
                >
                  {allFilteredRecordsSelected
                    ? `Отмечено ${selectedFilteredRecordCount} из ${recordStats.total}`
                    : `Отметить всю выборку · ${recordStats.total}`}
                </button>
                <button
                  className={`secondary-button compact ${
                    duplicatesOnly ? "is-active-filter" : ""
                  }`}
                  type="button"
                  disabled={!duplicateCount}
                  onClick={() => void showNextDuplicate()}
                >
                  {duplicateCount
                    ? duplicatesOnly
                      ? `Повтор опорного номера ${
                          (duplicateCursor %
                            Math.max(duplicateRecords.length, 1)) +
                          1
                        }/${duplicateCount}`
                      : `Повторяющиеся опорные · ${duplicateCount}`
                    : "Повторов опорных нет"}
                </button>
                <button
                  className={`secondary-button compact ${
                    exactDuplicatesOnly ? "is-active-filter" : ""
                  }`}
                  type="button"
                  disabled={!exactDuplicateCount}
                  onClick={() => void showNextExactDuplicate()}
                >
                  {exactDuplicateCount
                    ? exactDuplicatesOnly
                      ? `Полный дубликат ${
                          (exactDuplicateCursor %
                            Math.max(exactDuplicateRecords.length, 1)) +
                          1
                        }/${exactDuplicateCount}`
                      : `Полные дубликаты · ${exactDuplicateCount}`
                    : "Полных дубликатов нет"}
                </button>
                {exactDuplicatesOnly && exactDuplicateExtraCount > 0 && (
                  <button
                    className={`secondary-button compact ${
                      exactDuplicateExtrasSelected ? "is-active-filter" : ""
                    }`}
                    type="button"
                    disabled={
                      !matchingExactDuplicateExtraCount || !!bulkDeleting
                    }
                    onClick={toggleExactDuplicateExtras}
                  >
                    {exactDuplicateExtrasSelected
                      ? `Отмечены только лишние · ${selectedFilteredRecordCount}`
                      : `Отметить только лишние · ${matchingExactDuplicateExtraCount}`}
                  </button>
                )}
                {exactDuplicateExtrasSelected && (
                  <button
                    className="danger-button compact master-duplicate-cleanup"
                    type="button"
                    disabled={
                      !masterEditable ||
                      !selectedFilteredRecordCount ||
                      !!bulkDeleting
                    }
                    onClick={() => void deleteSelectedExactDuplicateExtras()}
                  >
                    {bulkDeleting === "exact-duplicate-extras"
                      ? "Удаляем лишние копии…"
                      : `Удалить лишние копии · ${selectedFilteredRecordCount}`}
                  </button>
                )}
                <button
                  className="secondary-button compact"
                  type="button"
                  data-tour="master-add-row"
                  onClick={openCreate}
                  disabled={!masterEditable}
                  title={
                    masterEditable
                      ? undefined
                      : "Сначала займите мастер-файл"
                  }
                >
                  + Добавить строку
                </button>
              </div>
            )}
          </div>

          {view === "records" && filterOpen && (
            <div className="master-filter-panel" data-tour="master-filter-panel">
              <div className="master-filter-heading">
                <div>
                  <strong>Фильтр</strong>
                  <span>
                    Выберите один или несколько известных параметров master.
                  </span>
                </div>
                <button
                  type="button"
                  aria-label="Закрыть фильтр"
                  onClick={() => setFilterOpen(false)}
                >
                  ×
                </button>
              </div>
              <fieldset className="master-parameter-options">
                <legend>Общие параметры</legend>
                {generalParameterOptions.length ? (
                  generalParameterOptions.map((parameter) => (
                    <label key={parameter.id}>
                      <input
                        type="checkbox"
                        checked={selectedParameterGroups.includes(parameter.id)}
                        onChange={(event) =>
                          setSelectedParameterGroups((current) =>
                            event.target.checked
                              ? [...current, parameter.id]
                              : current.filter(
                                  (value) => value !== parameter.id,
                                ),
                          )
                        }
                      />
                      <span>
                        <strong>{parameter.label}</strong>
                        <code>
                          {parameter.id === "pani"
                            ? "Все параметры с номером PANI"
                            : parameter.id === "pani_region"
                              ? "Все параметры с PANI и кодом региона"
                            : parameter.id === "custom"
                              ? "Все пользовательские варианты"
                              : parameter.id === "default"
                                ? NO_REGION_PREFIX
                                : `Все варианты ${parameter.label.toLowerCase()}`}
                        </code>
                      </span>
                      <small>{parameter.count}</small>
                    </label>
                  ))
                ) : (
                  <p>В master пока нет известных параметров.</p>
                )}
              </fieldset>
              <fieldset className="master-region-options">
                <legend>Коды регионов 1–84</legend>
                <div className="master-region-heading">
                  <span>
                    {regionRecordCount
                      ? `Строк с кодом региона: ${regionRecordCount}`
                      : "В master пока нет строк с кодом региона"}
                  </span>
                  <button
                    type="button"
                    disabled={!selectedRegions.length}
                    onClick={() => setSelectedRegions([])}
                  >
                    Очистить
                  </button>
                </div>
                <div className="master-region-combobox">
                  <label className="field">
                    <span>Выберите или введите код региона</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      list="master-region-codes"
                      value={regionInput}
                      onChange={(event) =>
                        setRegionInput(
                          event.target.value.replace(/\D/g, "").slice(0, 2),
                        )
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addRegionSelection();
                        }
                      }}
                      placeholder="Например, 77"
                    />
                  </label>
                  <datalist id="master-region-codes">
                    {regionOptions.map((region) => (
                      <option
                        key={region.value}
                        value={region.value}
                        label={
                          region.count
                            ? `Код ${region.value} · строк: ${region.count}`
                            : `Код ${region.value}`
                        }
                      />
                    ))}
                  </datalist>
                  <button
                    className="secondary-button compact"
                    type="button"
                    onClick={addRegionSelection}
                    disabled={!regionInput.trim()}
                  >
                    Добавить
                  </button>
                </div>
                {selectedRegions.length > 0 && (
                  <div className="master-selected-regions">
                    {selectedRegions.map((region) => (
                      <button
                        type="button"
                        key={region}
                        onClick={() =>
                          setSelectedRegions((current) =>
                            current.filter((value) => value !== region),
                          )
                        }
                        aria-label={`Убрать код региона ${region}`}
                      >
                        Регион {region} <span aria-hidden="true">×</span>
                      </button>
                    ))}
                  </div>
                )}
              </fieldset>
              <div className="master-filter-footer">
                <label className="master-check">
                  <input
                    type="checkbox"
                    checked={duplicatesOnly}
                    disabled={!duplicateCount}
                    onChange={(event) => {
                      setDuplicatesOnly(event.target.checked);
                      setDuplicateCursor(0);
                      if (event.target.checked) {
                        setExactDuplicatesOnly(false);
                        setExactDuplicateCursor(0);
                        setShortAonOnly(false);
                        setInvalidOnly(false);
                        setInvalidCursor(0);
                        setInvalidStartOnly(false);
                        setInvalidStartCursor(0);
                      }
                    }}
                  />
                  Только повторяющиеся опорные номера
                </label>
                <label className="master-check">
                  <input
                    type="checkbox"
                    checked={exactDuplicatesOnly}
                    disabled={!exactDuplicateCount}
                    onChange={(event) => {
                      setExactDuplicatesOnly(event.target.checked);
                      setExactDuplicateCursor(0);
                      if (event.target.checked) {
                        setDuplicatesOnly(false);
                        setDuplicateCursor(0);
                        setShortAonOnly(false);
                        setInvalidOnly(false);
                        setInvalidCursor(0);
                        setInvalidStartOnly(false);
                        setInvalidStartCursor(0);
                      }
                    }}
                  />
                  Только полностью одинаковые строки
                </label>
                <label className="master-check">
                  <input
                    type="checkbox"
                    checked={shortAonOnly}
                    disabled={!recordStats.shortAonRecordCount}
                    onChange={(event) => {
                      setShortAonOnly(event.target.checked);
                      if (event.target.checked) {
                        setDuplicatesOnly(false);
                        setDuplicateCursor(0);
                        setExactDuplicatesOnly(false);
                        setExactDuplicateCursor(0);
                        setInvalidOnly(false);
                        setInvalidCursor(0);
                        setInvalidStartOnly(false);
                        setInvalidStartCursor(0);
                      }
                    }}
                  />
                  Опорный с коротким АОН · 3–5 символов
                </label>
                <button
                  className="text-button"
                  type="button"
                  disabled={!activeFilterCount}
                  onClick={() => {
                    setSelectedParameterGroups([]);
                    setSelectedRegions([]);
                    setDuplicatesOnly(false);
                    setDuplicateCursor(0);
                    setExactDuplicatesOnly(false);
                    setExactDuplicateCursor(0);
                    setShortAonOnly(false);
                    setInvalidOnly(false);
                    setInvalidCursor(0);
                    setInvalidStartOnly(false);
                    setInvalidStartCursor(0);
                  }}
                >
                  Сбросить фильтр
                </button>
              </div>
            </div>
          )}

          {view === "records" && (
            <div className="master-batch-actions">
              <section
                className="master-batch-card"
                data-tour="master-bulk-delete-a"
              >
                <button
                  className="master-batch-toggle"
                  type="button"
                  aria-expanded={batchPanel === "a"}
                  onClick={() =>
                    setBatchPanel((current) => (current === "a" ? "" : "a"))
                  }
                >
                  <span>Пакетное удаление опорных номеров</span>
                  <span aria-hidden="true">{batchPanel === "a" ? "−" : "+"}</span>
                </button>
                {batchPanel === "a" && (
                  <div className="master-batch-body">
                  <label className="field">
                    <span>Опорные номера</span>
                    <textarea
                      value={bulkDeleteANumbers}
                      onChange={(event) =>
                        setBulkDeleteANumbers(event.target.value)
                      }
                      placeholder={"79000000001\n79000000002"}
                      disabled={!masterEditable || !!bulkDeleting}
                      spellCheck={false}
                    />
                    <small>
                      Каждый найденный опорный номер будет удалён вместе со
                      всеми привязанными АОН одной версией истории.
                    </small>
                    {!!parseNumbers(bulkDeleteANumbers).filter(
                      hasInvalidNumberLength,
                    ).length && (
                      <small className="number-length-warning">
                        Среди введённых опорных номеров есть номера с длиной не 11
                        символов. Это предупреждение не блокирует операцию.
                      </small>
                    )}
                  </label>
                  <button
                    className="danger-button"
                    type="button"
                    onClick={() => void batchDeleteA()}
                    disabled={
                      !masterEditable ||
                      !parseNumbers(bulkDeleteANumbers).length ||
                      !!bulkDeleting
                    }
                  >
                    {bulkDeleting === "a"
                      ? "Удаляем…"
                      : "Удалить опорные номера"}
                  </button>
                  </div>
                )}
              </section>
              <section
                className="master-batch-card"
                data-tour="master-bulk-delete-b"
              >
                <button
                  className="master-batch-toggle"
                  type="button"
                  aria-expanded={batchPanel === "b"}
                  onClick={() =>
                    setBatchPanel((current) => (current === "b" ? "" : "b"))
                  }
                >
                  <span>Пакетное удаление АОН во всём мастер-файле</span>
                  <span aria-hidden="true">{batchPanel === "b" ? "−" : "+"}</span>
                </button>
                {batchPanel === "b" && (
                  <div className="master-batch-body">
                  <label className="field">
                    <span>АОН</span>
                    <textarea
                      value={bulkDeleteBNumbers}
                      onChange={(event) =>
                        setBulkDeleteBNumbers(event.target.value)
                      }
                      placeholder={"79100000001\n79100000002"}
                      disabled={!masterEditable || !!bulkDeleting}
                      spellCheck={false}
                    />
                    <small>
                      Указанные АОН удаляются из всех связок. Пустая связка
                      автоматически получает собственный опорный номер как АОН.
                    </small>
                    {!!parseNumbers(bulkDeleteBNumbers).filter(
                      hasInvalidNumberLength,
                    ).length && (
                      <small className="number-length-warning">
                        Среди введённых АОН есть номера с длиной не 11 символов.
                        Это предупреждение не блокирует операцию.
                      </small>
                    )}
                  </label>
                  <button
                    className="danger-button"
                    type="button"
                    onClick={() => void batchDeleteB()}
                    disabled={
                      !masterEditable ||
                      !parseNumbers(bulkDeleteBNumbers).length ||
                      !!bulkDeleting
                    }
                  >
                    {bulkDeleting === "b" ? "Удаляем…" : "Удалить АОН"}
                  </button>
                  </div>
                )}
              </section>
              <section
                className="master-batch-card"
                data-tour="master-scoped-delete"
              >
                <button
                  className="master-batch-toggle"
                  type="button"
                  aria-expanded={batchPanel === "scoped-b"}
                  onClick={() =>
                    setBatchPanel((current) =>
                      current === "scoped-b" ? "" : "scoped-b",
                    )
                  }
                >
                  <span>
                    Удаление АОН у выбранных опорных номеров
                    {!!(
                      selectedFilteredRecordCount ||
                      scopedSelectedANumbers.length
                    ) && (
                      <small>
                        Строк: {selectedFilteredRecordCount}; опор вручную: {scopedSelectedANumbers.length}
                      </small>
                    )}
                  </span>
                  <span aria-hidden="true">
                    {batchPanel === "scoped-b" ? "−" : "+"}
                  </span>
                </button>
                {batchPanel === "scoped-b" && (
                  <div className="master-batch-body is-scoped">
                    <div className="master-scoped-a-selection">
                      <label className="field">
                        <span>Выбранные опорные номера</span>
                        <textarea
                          value={scopedDeleteANumbers}
                          onChange={(event) =>
                            setScopedDeleteANumbers(event.target.value)
                          }
                          placeholder={"Отметьте опорные номера в текущей базе\nили вставьте их сюда вручную"}
                          disabled={!masterEditable || !!bulkDeleting}
                          spellCheck={false}
                        />
                        <small>
                          Можно отметить конкретные строки в таблице, выбрать всю
                          текущую выборку или вставить опорные номера вручную.
                        </small>
                      </label>
                      {!!scopedSelectedANumbers.length && (
                        <div
                          className="master-selected-a-list"
                          aria-label="Выбранные опорные номера"
                        >
                          {scopedSelectedANumbers.map((number) => (
                            <button
                              type="button"
                              key={number}
                              onClick={() => toggleScopedANumber(number, false)}
                              disabled={!!bulkDeleting}
                              aria-label={`Убрать опорный номер ${number} из выбранных`}
                            >
                              <code>{number}</code>
                              <span aria-hidden="true">×</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {!!selectedFilteredRecordCount && (
                        <div className="master-filter-selection-summary">
                          <strong>
                            Отмечено строк: {selectedFilteredRecordCount}
                          </strong>
                          <span>
                            {exactDuplicateExtrasSelected
                              ? "Выбраны только лишние физические копии; по одному оригиналу в группе сохранено."
                              : allFilteredRecordsSelected
                              ? "Учтены все страницы и активный фильтр."
                              : "Отмечены отдельные физические строки."}
                          </span>
                          <button
                            className="text-button"
                            type="button"
                            onClick={clearRecordSelection}
                            disabled={!!bulkDeleting}
                          >
                            Снять отметки
                          </button>
                        </div>
                      )}
                    </div>
                    <label className="field">
                      <span>АОН для удаления только у этих опорных номеров</span>
                      <textarea
                        value={scopedDeleteBNumbers}
                        onChange={(event) =>
                          setScopedDeleteBNumbers(event.target.value)
                        }
                        placeholder={"79100000001\n79100000002"}
                        disabled={!masterEditable || !!bulkDeleting}
                        spellCheck={false}
                      />
                      <small>
                        Те же АОН у остальных опорных номеров останутся без
                        изменений. Пустая связка получит собственный опорный номер
                        как АОН.
                      </small>
                      {!![
                        ...parseNumbers(scopedDeleteANumbers),
                        ...parseNumbers(scopedDeleteBNumbers),
                      ].filter(hasInvalidNumberLength).length && (
                        <small className="number-length-warning">
                          Среди введённых значений есть номера с длиной не 11
                          символов. Это предупреждение не блокирует операцию.
                        </small>
                      )}
                    </label>
                    <button
                      className="danger-button"
                      type="button"
                      onClick={() => void batchDeleteBForSelectedA()}
                      disabled={
                        !masterEditable ||
                        (!parseNumbers(scopedDeleteANumbers).length &&
                          !selectedFilteredRecordCount) ||
                        !parseNumbers(scopedDeleteBNumbers).length ||
                        !!bulkDeleting
                      }
                    >
                      {bulkDeleting === "scoped-b"
                        ? "Удаляем…"
                        : "Удалить АОН у выбранных опорных номеров"}
                    </button>
                  </div>
                )}
              </section>
            </div>
          )}

          {view === "history" && (
            <div
              className="history-date-filters"
              aria-label="Фильтр истории по дате"
              data-tour="master-history-dates"
            >
              <label>
                <span>С даты</span>
                <input
                  type="date"
                  value={historyDateFrom}
                  max={historyDateTo || undefined}
                  onChange={(event) => setHistoryDateFrom(event.target.value)}
                />
              </label>
              <label>
                <span>По дату</span>
                <input
                  type="date"
                  value={historyDateTo}
                  min={historyDateFrom || undefined}
                  onChange={(event) => setHistoryDateTo(event.target.value)}
                />
              </label>
              <button
                className="secondary-button compact"
                type="button"
                disabled={!historyDateFrom && !historyDateTo}
                onClick={() => {
                  setHistoryDateFrom("");
                  setHistoryDateTo("");
                }}
              >
                Сбросить даты
              </button>
              <small>Границы периода учитываются по местному времени.</small>
            </div>
          )}

          {showEditor &&
            view === "records" &&
            !editing &&
            renderRecordEditor()}

          {loading ? (
            <div className="master-empty">Загружаем данные…</div>
          ) : view === "records" ? (
            records.length ? (
              <>
              <div className="master-records-pager" aria-label="Пагинация записей">
                <label className="master-page-size">
                  <span>На странице</span>
                  <select
                    value={recordsPageSize}
                    onChange={(event) => {
                      const next = Number(event.target.value) as RecordPageSize;
                      setRecordsPageSize(next);
                      setRecordsOffset(0);
                    }}
                  >
                    {RECORD_PAGE_SIZES.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="master-pager-actions">
                  <button
                    className="secondary-button compact"
                    type="button"
                    disabled={recordsOffset <= 0 || loading}
                    onClick={() =>
                      void loadRecords(
                        Math.max(0, recordsOffset - recordsPageSize),
                      )
                    }
                  >
                    Назад
                  </button>
                  <span>
                    {recordStats.total === 0
                      ? "0 из 0"
                      : `${recordsOffset + 1}–${
                          recordsOffset + records.length
                        } из ${recordStats.total}`}
                  </span>
                  <button
                    className="secondary-button compact"
                    type="button"
                    disabled={!recordsHasMore || loading}
                    onClick={() =>
                      void loadRecords(recordsOffset + recordsPageSize)
                    }
                  >
                    Вперёд
                  </button>
                </div>
              </div>
              <div className="master-table-wrap master-scroll-window">
                <table className="master-table">
                  <thead>
                    <tr>
                      <th>Выбор / строка</th>
                      <th>ID / опорный номер</th>
                      <th>АОН</th>
                      <th>Параметр</th>
                      <th>Изменено</th>
                      <th aria-label="Действия" />
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((record) => {
                      const recordSelected = exactDuplicateExtrasSelected
                        ? Boolean(record.isExactDuplicateExtra) &&
                          !excludedSelectedRecordIdSet.has(record.id)
                        : allFilteredRecordsSelected
                          ? !excludedSelectedRecordIdSet.has(record.id)
                          : selectedRecordIdSet.has(record.id);
                      const displayedBNumbers = visibleBNumbers(
                        record.bNumbers,
                        query,
                        6,
                        focusedInvalidId === record.id,
                      );
                      const invalidAons = invalidBNumbers(record.bNumbers);
                      const invalidStartAons = invalidStartBNumbers(
                        record.bNumbers,
                      );
                      const shortAon = isSingleShortAon(record.bNumbers)
                        ? record.bNumbers[0]
                        : "";
                      const whitespaceAons = record.bNumbers.filter(
                        hasInvalidNumberWhitespace,
                      );
                      return (
                      <Fragment key={record.id}>
                        <tr
                          ref={(node) => {
                            if (node)
                              recordRefs.current.set(record.id, node);
                            else recordRefs.current.delete(record.id);
                          }}
                          className={[
                            record.isDuplicate ? "is-duplicate" : "",
                            record.isExactDuplicate
                              ? "is-exact-duplicate"
                              : "",
                            focusedDuplicateId === record.id
                              ? "is-duplicate-focus"
                              : "",
                            focusedExactDuplicateId === record.id
                              ? "is-exact-duplicate-focus"
                              : "",
                            editing?.id === record.id
                              ? "is-editing"
                              : "",
                            recordHasInvalidNumbers(record)
                              ? "has-invalid-number"
                              : "",
                            focusedInvalidId === record.id
                              ? "is-invalid-focus"
                              : "",
                            recordHasInvalidNumberStart(record)
                              ? "has-invalid-number-start"
                              : "",
                            recordHasInvalidNumberWhitespace(record)
                              ? "has-invalid-number-whitespace"
                              : "",
                            focusedInvalidStartId === record.id
                              ? "is-invalid-start-focus"
                              : "",
                            recordSelected
                              ? "is-selected-for-aon-delete"
                              : "",
                            exactDuplicateExtrasSelected &&
                            record.isExactDuplicateExtra &&
                            recordSelected
                              ? "is-selected-exact-duplicate-extra"
                              : "",
                            shortAon ? "has-short-aon" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                        >
                        <td>
                          <label className="master-record-selection">
                            <input
                              type="checkbox"
                              checked={recordSelected}
                              disabled={
                                !!bulkDeleting ||
                                (exactDuplicateExtrasSelected &&
                                  !record.isExactDuplicateExtra)
                              }
                              onChange={(event) =>
                                toggleRecordSelection(
                                  record.id,
                                  event.target.checked,
                                )
                              }
                              aria-label={`Выбрать строку ${record.lineNumber} с опорным номером ${record.aNumber}`}
                            />
                            <span className="line-number">
                              {record.lineNumber}
                            </span>
                          </label>
                        </td>
                        <td>
                          <div className="record-identity">
                            <strong
                              className={[
                                hasInvalidNumberLength(record.aNumber)
                                  ? "is-invalid-number"
                                  : "",
                                hasInvalidNumberStart(record.aNumber)
                                  ? "is-invalid-number-start"
                                  : "",
                                hasInvalidNumberWhitespace(record.aNumber)
                                  ? "is-invalid-number-whitespace"
                                  : "",
                              ].filter(Boolean).join(" ")}
                            >
                              <HighlightedValue
                                value={record.aNumber}
                                query={query}
                              />
                            </strong>
                            <code>{record.id}</code>
                            {record.isDuplicate && (
                              <span className="duplicate-badge">
                                {record.duplicateSourceRows?.length
                                  ? `Дубликат исходника · строки ${record.duplicateSourceRows.join(", ")}`
                                  : "Повторяющийся опорный номер"}
                              </span>
                            )}
                            {record.isExactDuplicate && (
                              <span className="exact-duplicate-badge">
                                {record.isExactDuplicateExtra
                                  ? "Полностью одинаковая строка · лишняя копия"
                                  : "Полностью одинаковая строка · оригинал группы будет сохранён"}
                              </span>
                            )}
                            {exactDuplicateExtrasSelected &&
                              record.isExactDuplicateExtra &&
                              recordSelected && (
                                <span className="exact-duplicate-selection-badge">
                                  ✓ Отмечено для удаления
                                </span>
                              )}
                            {hasInvalidNumberLength(record.aNumber) && (
                              <span className="record-number-warning is-support-warning">
                                Длина опорного номера не 11 символов
                              </span>
                            )}
                            {hasInvalidNumberStart(record.aNumber) && (
                              <span className="record-number-warning is-blocking-start">
                                Опорный номер должен начинаться с 7
                              </span>
                            )}
                            {hasInvalidNumberWhitespace(record.aNumber) && (
                              <span className="record-number-warning is-whitespace-warning">
                                В опорном номере есть пробелы
                              </span>
                            )}
                            {!!record.comment && (
                              <span className="master-record-comment">
                                <span aria-hidden="true">!</span>
                                <strong>{record.comment}</strong>
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <div className="record-aon-summary">
                            <div className="number-chips">
                              {displayedBNumbers.map((number) => (
                                <code
                                  className={[
                                    invalidAons.includes(number)
                                      ? "is-invalid-number"
                                      : "",
                                    invalidStartAons.includes(number)
                                      ? "is-invalid-number-start"
                                      : "",
                                    number === shortAon
                                      ? "is-short-aon-number"
                                      : "",
                                    hasInvalidNumberWhitespace(number)
                                      ? "is-invalid-number-whitespace"
                                      : "",
                                  ].filter(Boolean).join(" ")}
                                  key={number}
                                >
                                  <HighlightedValue
                                    value={number}
                                    query={query}
                                  />
                                </code>
                              ))}
                              {record.bNumbers.length >
                                displayedBNumbers.length && (
                                <span>
                                  +
                                  {record.bNumbers.length -
                                    displayedBNumbers.length}
                                </span>
                              )}
                            </div>
                            {!!invalidAons.length && (
                              <span className="record-number-warning is-aon-warning">
                                Имеются АОН с длиной не 11 символов
                              </span>
                            )}
                            {shortAon && (
                              <span className="short-aon-badge">
                                Короткий АОН · допустимо · формат 4:2
                              </span>
                            )}
                            {!!invalidStartAons.length && (
                              <span className="record-number-warning is-blocking-start">
                                Имеются АОН, которые начинаются не с 7
                              </span>
                            )}
                            {!!whitespaceAons.length && (
                              <span className="record-number-warning is-whitespace-warning">
                                Имеются АОН с пробелами
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <code className="record-parameter">
                            {record.sourcePrefix}
                          </code>
                          <button
                            className="master-logical-row-button"
                            type="button"
                            onClick={() => openLogicalRowPreview(record)}
                          >
                            Показать полную строку
                          </button>
                        </td>
                        <td>
                          <div className="record-update">
                            <span>{formatDate(record.updatedAt)}</span>
                            <small>
                              {masterVersion(record.updatedRevision)} · версия
                              строки {record.version}
                            </small>
                          </div>
                        </td>
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              onClick={() =>
                                recordHasInvalidNumberStart(record)
                                  ? void openInvalidRecordForEdit(record)
                                  : openEdit(record)
                              }
                              disabled={
                                lockedByOther ||
                                lockChanging ||
                                (!masterEditable &&
                                  !recordHasInvalidNumberStart(record))
                              }
                            >
                              Изменить
                            </button>
                            <button
                              className="is-danger"
                              type="button"
                              onClick={() => void deleteRecord(record)}
                              disabled={!masterEditable}
                            >
                              Удалить
                            </button>
                          </div>
                        </td>
                        </tr>
                        {editing?.id === record.id && (
                          <tr className="master-inline-editor-row">
                            <td colSpan={6}>
                              {renderRecordEditor(true)}
                            </td>
                          </tr>
                        )}
                        {aonSearchMatchesByRecord.has(record.id) &&
                          editing?.id !== record.id && (
                            <tr className="master-inline-editor-row is-search-reveal">
                              <td colSpan={6}>
                                {renderAonSearchReveal(record)}
                              </td>
                            </tr>
                          )}
                        {focusedInvalidId === record.id &&
                          editing?.id !== record.id &&
                          !aonSearchMatchesByRecord.has(record.id) && (
                            <tr className="master-inline-editor-row is-invalid-reveal">
                              <td colSpan={6}>
                                {renderInvalidNumberReveal(record)}
                              </td>
                            </tr>
                          )}
                        {focusedInvalidStartId === record.id &&
                          editing?.id !== record.id &&
                          !aonSearchMatchesByRecord.has(record.id) && (
                            <tr className="master-inline-editor-row is-invalid-reveal is-blocking-start">
                              <td colSpan={6}>
                                {renderInvalidStartReveal(record)}
                              </td>
                            </tr>
                          )}
                      </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              </>
            ) : (
              <div className="master-empty">
                <strong>
                  {query || activeFilterCount
                    ? "Совпадений не найдено"
                    : "Мастер файл пока пуст"}
                </strong>
                <span>
                  {query || activeFilterCount
                    ? "Измените запрос поиска или настройки фильтра."
                    : "Загрузите ранее созданный CSV для первого слияния или добавьте строку вручную."}
                </span>
              </div>
            )
          ) : history.length ? (
            <div
              className="history-list master-scroll-window"
              onScroll={(event) => {
                const element = event.currentTarget;
                if (
                  historyHasMore &&
                  !historyLoadingMore &&
                  element.scrollTop + element.clientHeight >=
                    element.scrollHeight - 120
                )
                  void loadHistory(history.length);
              }}
            >
              {history.map((item) => (
                <article
                  className={[
                    "history-item",
                    historyItemHasInvalidNumbers(item)
                      ? "has-invalid-number"
                      : "",
                    historyItemHasInvalidNumberStart(item)
                      ? "has-invalid-number-start"
                      : "",
                    historyItemHasInvalidNumberWhitespace(item)
                      ? "has-invalid-number-whitespace"
                      : "",
                  ].filter(Boolean).join(" ")}
                  key={item.id}
                >
                  <div className="history-marker">
                    <span className={`history-action is-${item.action}`}>
                      {ACTION_LABELS[item.action]}
                    </span>
                    <strong>{masterVersion(item.revision)}</strong>
                  </div>
                  <div className="history-body">
                    <div className="history-title">
                      <div>
                        <strong
                          className={historyNumberClass(
                            item.after?.aNumber ??
                              item.before?.aNumber ??
                              item.recordId,
                          )}
                        >
                          {item.after?.aNumber ??
                            item.before?.aNumber ??
                            item.recordId}
                        </strong>
                        <code>{item.recordId}</code>
                      </div>
                      <time>{formatDate(item.createdAt)}</time>
                    </div>
                    <ul>
                      {snapshotChanges(item).map((change) => (
                        <li key={change}>{change}</li>
                      ))}
                    </ul>
                    {!!item.removedBNumbers.length && (
                      <div className="history-removed-preview">
                        <strong>Удалённые АОН:</strong>
                        {item.removedBNumbers.slice(0, 3).map((number, index) => (
                          <code
                            className={historyNumberClass(
                              number,
                              item.before?.bNumbers,
                            )}
                            key={`${number}-${index}`}
                          >
                            {number}
                          </code>
                        ))}
                        {item.removedBNumbers.length > 3 && (
                          <span>+{item.removedBNumbers.length - 3}</span>
                        )}
                      </div>
                    )}
                    <HistoryAonDetails item={item} />
                    <div className="history-meta">
                      {item.actor && (
                        <span>
                          Пользователь: <code>{item.actor}</code>
                        </span>
                      )}
                      {item.lineNumber && <span>Строка {item.lineNumber}</span>}
                      {(item.after?.sourcePrefix ??
                        item.before?.sourcePrefix) && (
                        <span>
                          Параметр:{" "}
                          <code>
                            {item.after?.sourcePrefix ??
                              item.before?.sourcePrefix}
                          </code>
                        </span>
                      )}
                      {item.sourceFile && (
                        <span>
                          Слияние: {item.sourceFile}
                          {item.sourceRow ? `, строка ${item.sourceRow}` : ""}
                        </span>
                      )}
                      {historyItemHasInvalidNumbers(item) && (
                        <span className="number-length-badge">
                          Есть номера с длиной не 11 символов
                        </span>
                      )}
                      {historyItemHasInvalidNumberStart(item) && (
                        <span className="number-start-blocking-badge">
                          Есть номера, которые начинаются не с 7
                        </span>
                      )}
                    </div>
                  </div>
                </article>
              ))}
              {historyLoadingMore && (
                <div className="master-page-loading">
                  Загружаем следующие 200 изменений…
                </div>
              )}
            </div>
          ) : (
            <div className="master-empty">
              <strong>
                {query || historyDateFrom || historyDateTo
                  ? "По заданным фильтрам изменений не найдено"
                  : "История пока пуста"}
              </strong>
              <span>
                {query || historyDateFrom || historyDateTo
                  ? "Измените поисковый запрос или диапазон дат."
                  : "Здесь появятся добавления, замены и удаления строк."}
              </span>
            </div>
          )}

          {!loading && (
            <div className="master-list-footer">
              <span>
                {view === "records"
                  ? recordStats.total === 0
                    ? "Записей нет"
                    : `Страница ${
                        Math.floor(recordsOffset / recordsPageSize) + 1
                      } из ${Math.max(
                        1,
                        Math.ceil(recordStats.total / recordsPageSize),
                      )} · на странице ${recordsPageSize}`
                  : `Показано ${history.length} из ${historyTotal}`}
              </span>
              <small>
                {view === "records"
                  ? "Размер страницы можно изменить в блоке «На странице»."
                  : historyHasMore
                    ? "Следующие 200 изменений загрузятся при прокрутке"
                    : "Вся найденная история загружена"}
              </small>
            </div>
          )}
        </section>
      </div>

      <footer>
        <span>Агент мобильной карусели</span>
        <span>Master хранится локально и не удаляется по TTL</span>
      </footer>

      {logicalRowPreview && (
        <div
          className="master-lock-backdrop"
          onClick={() => setLogicalRowPreview(null)}
        >
          <section
            className="master-logical-row-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="master-logical-row-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="master-logical-row-dialog-heading">
              <div>
                <span>Строка {logicalRowPreview.lineNumber}</span>
                <h2 id="master-logical-row-title">Полная строка записи</h2>
                <small>
                  Опорный номер {logicalRowPreview.aNumber} · ID {logicalRowPreview.id}
                </small>
              </div>
              <button
                type="button"
                aria-label="Закрыть полную строку"
                onClick={() => setLogicalRowPreview(null)}
              >
                ×
              </button>
            </div>
            <code className="master-logical-row-value" tabIndex={0}>
              {logicalRowPreview.logicalRow ??
                formattedImportLine(logicalRowPreview)}
            </code>
            <div className="master-logical-row-dialog-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setLogicalRowPreview(null)}
              >
                Закрыть
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => void copyLogicalRowPreview()}
              >
                {copiedLogicalRow ? "Скопировано" : "Скопировать строку"}
              </button>
            </div>
          </section>
        </div>
      )}

      {!draftDialogOpen && clearDialogOpen && user?.voiceAdmin && (
        <div className="master-lock-backdrop">
          <section
            className="master-lock-dialog master-clear-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="master-clear-dialog-title"
            aria-describedby="master-clear-dialog-description"
          >
            <span className="master-lock-dialog-icon" aria-hidden="true">
              !
            </span>
            <p className="eyebrow">Опасное действие</p>
            <h2 id="master-clear-dialog-title">
              Полностью очистить мастер-файл?
            </h2>
            <p id="master-clear-dialog-description">
              Вся база номеров будет удалена. Сейчас в мастер-файле{" "}
              <strong>{recordStats.activeCount} активных строк</strong>.
              Удаление запишется одной строкой «Очистка» в новой версии
              журнала (без копирования каждой связки в историю).
            </p>
            <div className="master-clear-dialog-actions">
              <button
                className="secondary-button"
                type="button"
                autoFocus
                onClick={() => setClearDialogOpen(false)}
                disabled={clearingMaster}
              >
                Отмена
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={() => void clearMaster()}
                disabled={clearingMaster || !masterEditable}
              >
                {clearingMaster ? "Удаляем…" : "Подтвердить удаление"}
              </button>
            </div>
          </section>
        </div>
      )}

      {!draftDialogOpen &&
        !clearDialogOpen &&
        resetHistoryDialogOpen &&
        user?.voiceAdmin && (
          <div className="master-lock-backdrop">
            <section
              className="master-lock-dialog master-clear-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="master-reset-history-title"
              aria-describedby="master-reset-history-description"
            >
              <span className="master-lock-dialog-icon" aria-hidden="true">
                ↺
              </span>
              <p className="eyebrow">Новая базовая версия</p>
              <h2 id="master-reset-history-title">
                Очистить журнал и обнулить версию?
              </h2>
              <p id="master-reset-history-description">
                Все записи журнала, сведения о прошлых слияниях и старые версии
                будут удалены. Текущие <strong>{recordStats.activeCount}</strong>{" "}
                активных строк и комментарии сохранятся как базовая версия
                <strong> T2-0</strong>. Отменить это действие после подтверждения
                нельзя.
              </p>
              <div className="master-clear-dialog-actions">
                <button
                  className="secondary-button"
                  type="button"
                  autoFocus
                  onClick={() => setResetHistoryDialogOpen(false)}
                  disabled={resettingHistory}
                >
                  Отмена
                </button>
                <button
                  className="danger-button"
                  type="button"
                  onClick={() => void resetMasterHistory()}
                  disabled={resettingHistory || !masterEditable}
                >
                  {resettingHistory
                    ? "Очищаем…"
                    : "Подтвердить очистку"}
                </button>
              </div>
            </section>
          </div>
        )}

      {draftDialogOpen && pendingDraft && (
        <div className="master-lock-backdrop">
          <section
            className="master-lock-dialog master-draft-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="master-draft-dialog-title"
            aria-describedby="master-draft-dialog-description"
          >
            <span className="master-lock-dialog-icon" aria-hidden="true">
              ↺
            </span>
            <p className="eyebrow">Незавершённая работа</p>
            <h2 id="master-draft-dialog-title">
              Продолжить с места остановки?
            </h2>
            <p id="master-draft-dialog-description">
              Приложение сохранило изменения, которые не были записаны в
              мастер-файл.
              {pendingDraft.editor && (
                <strong>
                  {pendingDraft.editor.editing
                    ? `Редактирование строки ${pendingDraft.editor.editing.lineNumber}`
                    : "Добавление новой строки"}
                </strong>
              )}
              {pendingDraft.analysis && (
                <strong>
                  Слияние файла {pendingDraft.analysis.sourceName}
                </strong>
              )}
            </p>
            <small>
              Черновик сохранён{" "}
              {formatDate(pendingDraft.savedAt / 1000)}
            </small>
            <div className="master-draft-dialog-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={discardDraft}
              >
                Отказаться
              </button>
              <button
                className="primary-button"
                type="button"
                autoFocus
                onClick={continueDraft}
              >
                Продолжить работу
              </button>
            </div>
          </section>
        </div>
      )}

      {!draftDialogOpen &&
        lockDialogOpen &&
        lockedByOther &&
        masterLock.owner && (
        <div className="master-lock-backdrop">
          <section
            className="master-lock-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="master-lock-dialog-title"
            aria-describedby="master-lock-dialog-description"
          >
            <span className="master-lock-dialog-icon" aria-hidden="true">
              ⌁
            </span>
            <p className="eyebrow">Совместная работа</p>
            <h2 id="master-lock-dialog-title">
              Мастер-файл временно недоступен
            </h2>
            <p id="master-lock-dialog-description">
              На текущий момент мастер-файл занят пользователем
              <strong>{masterLock.owner.email}</strong>. До освобождения
              файла редактирование и остальные операции заблокированы.
            </p>
            {masterLock.acquiredAt && (
              <small>
                Файл занят {formatDate(masterLock.acquiredAt)}
              </small>
            )}
            <div className="master-lock-dialog-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => void notifyLockOwner()}
                disabled={notifyingLockOwner}
              >
                {notifyingLockOwner
                  ? "Отправляем…"
                  : "Уведомить пользователя"}
              </button>
              <button
                className="primary-button"
                type="button"
                autoFocus
                onClick={() => setLockDialogOpen(false)}
              >
                Понятно
              </button>
            </div>
          </section>
        </div>
        )}

      {!draftDialogOpen &&
        !clearDialogOpen &&
        ownerNotificationOpen &&
        masterEditable &&
        masterLock.notification && (
          <div className="master-lock-backdrop">
            <section
              className="master-lock-dialog master-owner-notification-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="master-owner-notification-title"
              aria-describedby="master-owner-notification-description"
            >
              <span className="master-lock-dialog-icon" aria-hidden="true">
                !
              </span>
              <p className="eyebrow">Требуется ваше внимание</p>
              <h2 id="master-owner-notification-title">
                {masterLock.notification.kind === "upload_attempt"
                  ? "Другой пользователь пытается загрузить файл"
                  : "Другой пользователь ждёт мастер-файл"}
              </h2>
              <p id="master-owner-notification-description">
                Пользователь
                <strong>{masterLock.notification.requester.email}</strong>
                {masterLock.notification.kind === "upload_attempt"
                  ? " пытается подгрузить сформированный файл в мастер-файл. Завершите работу и освободите файл, когда это будет безопасно."
                  : " просит вас завершить работу или освободить мастер-файл."}
              </p>
              <small>
                Уведомление получено {formatDate(masterLock.notification.createdAt)}
              </small>
              <div className="master-lock-dialog-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setOwnerNotificationOpen(false)}
                >
                  Продолжить работу
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => {
                    setOwnerNotificationOpen(false);
                    void toggleMasterLock();
                  }}
                >
                  Освободить мастер-файл
                </button>
              </div>
            </section>
          </div>
        )}
    </main>
  );
}
