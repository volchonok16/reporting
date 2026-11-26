import { object } from '../../api/client';
import { Alert } from '../../components/Alert';

export function ScientificExclusions({ summary }: { summary?: Record<string, unknown> }) {
  const count = object(summary?.dispositions).excluded_scientific_inn;
  if (typeof count !== 'number' || count < 1) return null;
  return <Alert title={`Исключено строк с ИНН в экспоненциальной записи: ${count}`} tone="warning">
    <p>Эти строки сохранены в истории и отмечены в таблице, но не входят в CLIENTS, DOGTAGS и NUMBERS. Проверьте исключения перед подтверждением комплекта. Чтобы вернуть строку в обработку, укажите полный ИНН.</p>
    {object(summary?.counts).NUMBERS === 0 && <p>После исключений не осталось корректных назначений. Исправьте исходные данные для формирования файлов.</p>}
  </Alert>;
}
