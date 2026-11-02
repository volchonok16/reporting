// Deleting the account (Privacy Policy, «your rights»): says first what happens to
// the files and teams, then asks for the password. Afterwards — the landing page.

import { tr } from '#core';
import { cloud, CloudError } from '../cloud.ts';
import { askPassword, showMessage } from './dialog.ts';

export async function deleteAccount(): Promise<void> {
  let plan;
  try {
    plan = await cloud.deletionPreview();
  } catch (err) {
    await showMessage({ title: tr('Не удалось удалить аккаунт'), message: err instanceof CloudError ? err.message : tr('Не получилось. Проверьте связь и попробуйте ещё раз.') });
    return;
  }
  const lines = [
    plan.files ? tr('Ваши файлы удалятся: {0}.', plan.files) + (plan.shared ? ` ${tr('Открыто другим людям: {0} — у них эти файлы тоже пропадут.', plan.shared)}` : '') : tr('Своих файлов у вас нет.'),
    ...(plan.keptInTeams ? [tr('Файлы в проектах команд останутся команде: {0}.', plan.keptInTeams)] : []),
    ...plan.teamsHandedOver.map((t) => tr('Команда «{0}» перейдёт к {1}.', t.team, t.to)),
    ...plan.teamsDeleted.map((name) => tr('Команда «{0}» удалится: кроме вас, в ней никого нет.', name)),
    tr('Отменить это нельзя. Нужные файлы сохраните заранее: откройте файл → «Сохранить копию файла…».'),
  ];
  let error: string | undefined;
  for (;;) {
    const password = await askPassword({ title: tr('Удалить аккаунт?'), lines, label: tr('Пароль'), confirm: tr('Удалить аккаунт'), error });
    if (password === null) return;
    try {
      await cloud.deleteAccount(password);
      break;
    } catch (err) {
      error = err instanceof CloudError ? err.message : tr('Не получилось. Проверьте связь и попробуйте ещё раз.');
    }
  }
  await showMessage({ title: tr('Аккаунт удалён'), message: tr('Аккаунт и ваши файлы удалены с сервера.') });
  location.assign('/');
}
