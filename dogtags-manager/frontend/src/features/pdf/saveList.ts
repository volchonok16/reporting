import { canChooseDownloadLocation } from '../../api/client';

type Picker = Window & { showSaveFilePicker?: (options: { id: string; suggestedName: string }) => Promise<FileSystemFileHandle> };

export async function savePhoneList(filename: string, text: string, chooseLocation: boolean) {
  let file: FileSystemFileHandle | undefined;
  if (chooseLocation) {
    if (!canChooseDownloadLocation()) throw new Error('Выбор папки недоступен в этом браузере.');
    try { file = await (window as Picker).showSaveFilePicker!({ id: 'dogtags-pdf-numbers', suggestedName: filename }); }
    catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
      throw error;
    }
  }
  const blob = new Blob([text], { type: filename.endsWith('.csv') ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' });
  if (file) {
    let writable: FileSystemWritableFileStream | undefined;
    try {
      writable = await file.createWritable();
      await writable.write(blob);
      await writable.close();
    } catch {
      await writable?.abort().catch(() => {});
      throw new Error('Не удалось сохранить список. Проверьте доступ к папке и свободное место.');
    }
    return 'saved';
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return 'downloaded';
}
