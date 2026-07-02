import { toast } from 'sonner'
import { HttpError } from './api'

const WARNING_MESSAGE_PATTERNS = [
  /запланирован отпуск/i,
  /уже (есть|занят|добавлен|состоит)/i,
  /недостаточно прав/i,
  /нельзя/i,
  /укажите/i,
  /введите/i,
  /не совпадают/i,
  /не короче/i,
  /целое число/i,
  /недоступ/i,
  /допустимы/i,
  /файл больше/i,
  /файл не выбран/i,
  /некорректн/i,
  /email уже/i,
  /уже занят/i,
  /выберите сотрудника/i,
  /бронирование недоступно/i,
  /редактирование доступно/i,
  /нет изменений/i,
  /нет данных для сохранения/i,
]

export function isWarningMessage(message: string): boolean {
  return WARNING_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
}

export function isWarningError(err: unknown, message: string): boolean {
  if (err instanceof HttpError && (err.status === 403 || err.status === 409)) {
    return true
  }
  return isWarningMessage(message)
}

export function notifyError(err: unknown, fallback = 'Ошибка', id?: string | number): void {
  const message = err instanceof Error ? err.message : fallback
  toast.error(message, id != null ? { id } : undefined)
}

export function notifyProblem(err: unknown, fallback = 'Ошибка', id?: string | number): void {
  const message = err instanceof Error ? err.message : fallback
  if (isWarningError(err, message)) {
    notifyWarning(message, id)
  } else {
    notifyError(err, fallback, id)
  }
}

export function notifySuccess(message: string, id?: string | number): void {
  toast.success(message, id != null ? { id } : undefined)
}

export function notifyWarning(message: string, id?: string | number): void {
  toast.warning(message, id != null ? { id } : undefined)
}

export function notifyInfo(message: string, id?: string | number): void {
  toast.info(message, id != null ? { id } : undefined)
}

export function notifyLoading(message: string, id: string | number = 'progress'): string | number {
  toast.loading(message, { id })
  return id
}

export function updateLoading(message: string, id: string | number): void {
  toast.loading(message, { id })
}

export function dismissToast(id: string | number): void {
  toast.dismiss(id)
}
