// Outgoing mail: a minimal SMTP client on Node's own net/tls (no packages),
// and the letters Simmetrika sends. Without CS_SMTP_HOST mail is not sent —
// the letter goes to the log instead, which is enough for local development.
//
// Environment:
//   CS_SMTP_HOST, CS_SMTP_PORT (465), CS_SMTP_SECURE: ssl (TLS from the start) | tls (STARTTLS) | none
//   CS_SMTP_USER, CS_SMTP_PASS, CS_MAIL_FROM, CS_MAIL_FROM_NAME (Симметрика), CS_APP_URL (link in letters)

import { connect as tcpConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

export interface Letter {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type Mailer = (letter: Letter) => Promise<void>;

export interface SmtpConfig {
  host: string;
  port: number;
  secure: 'ssl' | 'tls' | 'none';
  user: string;
  pass: string;
  from: string;
  fromName: string;
}

export function smtpConfigFromEnv(env: Record<string, string | undefined>): SmtpConfig | null {
  if (!env.CS_SMTP_HOST || !env.CS_MAIL_FROM) return null;
  const secure = env.CS_SMTP_SECURE === 'tls' || env.CS_SMTP_SECURE === 'none' ? env.CS_SMTP_SECURE : 'ssl';
  return {
    host: env.CS_SMTP_HOST,
    port: Number(env.CS_SMTP_PORT ?? (secure === 'ssl' ? 465 : 587)),
    secure,
    user: env.CS_SMTP_USER ?? '',
    pass: env.CS_SMTP_PASS ?? '',
    from: env.CS_MAIL_FROM,
    fromName: env.CS_MAIL_FROM_NAME ?? 'Симметрика',
  };
}

/** Mail goes to the log: for development and tests. */
export function logMailer(log: (line: string) => void): Mailer {
  return async (letter) => log(`письмо для ${letter.to}: ${letter.subject}\n${letter.text}`);
}

/** Письма через почту reporting (тот же SMTP, что у статуса и сброса пароля). */
export function reportingMailer(url: string, secret: string): Mailer {
  return async (letter) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': secret },
      body: JSON.stringify({ to: letter.to, subject: letter.subject, html: letter.html, text: letter.text }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`почта reporting: HTTP ${response.status} ${detail.slice(0, 200)}`);
    }
  };
}

const encodeWord = (s: string) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
const wrap76 = (s: string) => s.replace(/.{1,76}/g, '$&\r\n');

/** The whole message (headers + multipart text/html body), CRLF line ends, dot-stuffed. */
export function buildMessage(config: SmtpConfig, letter: Letter, now = new Date()): string {
  const boundary = `cs-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const domain = config.from.split('@')[1] ?? 'localhost';
  const part = (type: string, body: string) =>
    [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', wrap76(Buffer.from(body, 'utf8').toString('base64'))].join('\r\n');
  const message = [
    `From: ${encodeWord(config.fromName)} <${config.from}>`,
    `To: <${letter.to}>`,
    `Subject: ${encodeWord(letter.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${now.getTime().toString(36)}.${Math.random().toString(36).slice(2)}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    part('text/plain', letter.text),
    part('text/html', letter.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return message.replace(/\r\n\./g, '\r\n..');
}

/** Reads SMTP replies (multi-line "250-…" until "250 …"). */
function replyReader(getSocket: () => Socket | TLSSocket) {
  let buffer = '';
  let waiting: ((line: string) => void) | null = null;
  let failed: Error | null = null;
  let onError: ((e: Error) => void) | null = null;
  const tryResolve = () => {
    if (!waiting) return;
    const lines = buffer.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i]!) || /^\d{3}$/.test(lines[i]!)) {
        const reply = lines.slice(0, i + 1).join('\n');
        buffer = lines.slice(i + 1).join('\r\n');
        const w = waiting;
        waiting = null;
        onError = null;
        w(reply);
        return;
      }
    }
  };
  return {
    attach(socket: Socket | TLSSocket) {
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        tryResolve();
      });
      socket.on('error', (e: Error) => {
        failed = e;
        onError?.(e);
      });
      socket.on('close', () => {
        failed ??= new Error('SMTP: соединение закрыто');
        onError?.(failed);
      });
    },
    next(): Promise<string> {
      return new Promise((resolve, reject) => {
        if (failed) return reject(failed);
        waiting = resolve;
        onError = reject;
        tryResolve();
      });
    },
    socket: getSocket,
  };
}

export function smtpMailer(config: SmtpConfig, timeoutMs = 15000): Mailer {
  return async (letter) => {
    let socket: Socket | TLSSocket = await new Promise((resolve, reject) => {
      const s =
        config.secure === 'ssl'
          ? tlsConnect({ host: config.host, port: config.port, servername: config.host }, () => resolve(s))
          : tcpConnect({ host: config.host, port: config.port }, () => resolve(s));
      s.once('error', reject);
    });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('SMTP: нет ответа')));
    let reader = replyReader(() => socket);
    reader.attach(socket);
    const expect = async (command: string | null, code: string) => {
      if (command !== null) socket.write(command + '\r\n');
      const reply = await reader.next();
      if (!reply.startsWith(code)) {
        const shown = command?.startsWith('AUTH') || code === '235' ? '(авторизация)' : (command ?? 'приветствие');
        throw new Error(`SMTP: на «${shown.slice(0, 40)}» ответ ${reply.slice(0, 200)}`);
      }
      return reply;
    };
    const helo = 'canvas-studio';
    try {
      await expect(null, '220');
      await expect(`EHLO ${helo}`, '250');
      if (config.secure === 'tls') {
        await expect('STARTTLS', '220');
        const plain = socket;
        socket = await new Promise<TLSSocket>((resolve, reject) => {
          const s = tlsConnect({ socket: plain, servername: config.host }, () => resolve(s));
          s.once('error', reject);
        });
        socket.setTimeout(timeoutMs, () => socket.destroy(new Error('SMTP: нет ответа')));
        reader = replyReader(() => socket);
        reader.attach(socket);
        await expect(`EHLO ${helo}`, '250');
      }
      if (config.user) {
        await expect('AUTH LOGIN', '334');
        await expect(Buffer.from(config.user).toString('base64'), '334');
        await expect(Buffer.from(config.pass).toString('base64'), '235');
      }
      await expect(`MAIL FROM:<${config.from}>`, '250');
      await expect(`RCPT TO:<${letter.to}>`, '25');
      await expect('DATA', '354');
      await expect(buildMessage(config, letter) + '.', '250');
      socket.write('QUIT\r\n');
    } finally {
      socket.end();
    }
  };
}

// ---------- letters ----------

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const FONT = "Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * The look shared by every letter, as the editor itself: white card on a light
 * grey page, Inter/system font, the blue accent of the selection frame and the
 * Simmetrika mark (a PNG from the site: mail clients drop SVG; without the
 * site address — no picture, only the name). Tables and inline styles only — that is
 * what mail clients render. `rows` are ready <tr> rows of the card.
 */
function frame(subject: string, rows: string, appUrl?: string): string {
  const url = appUrl ? escapeHtml(appUrl.replace(/\/+$/, '')) : '';
  const mark = url ? `<td style="padding:0 10px 0 0;"><img src="${url}/apps/web/icons/icon-192.png" width="28" height="28" alt="" style="display:block;border:0;border-radius:7px;"></td>` : '';
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:32px 16px;background:#f5f5f5;font-family:${FONT};color:#1e1e1e;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;margin:0 auto;background:#ffffff;border:1px solid #e6e6e6;border-radius:12px;">
    <tr><td style="padding:24px 28px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        ${mark}
        <td style="font-size:15px;font-weight:600;letter-spacing:-0.1px;color:#1e1e1e;">Симметрика</td>
      </tr></table>
    </td></tr>
${rows}
    <tr><td style="padding:14px 28px;border-top:1px solid #e6e6e6;font-size:11px;line-height:1.5;color:#9a9a9a;">
      Симметрика — совместное проектирование интерфейсов.${url ? `<br><a href="${url}/" style="color:#4f5bd5;text-decoration:none;">${url.replace(/^https?:\/\//, '')}</a>` : ''}
    </td></tr>
  </table>
</body></html>`;
}

const LETTERS = {
  verify: {
    subject: 'Подтвердите почту — Симметрика',
    intro: 'Спасибо за регистрацию в Симметрике! Чтобы подтвердить почту, введите этот код в окне регистрации:',
    ignore: 'Если вы не регистрировались — просто проигнорируйте письмо: аккаунт без подтверждения не заработает.',
  },
  reset: {
    subject: 'Код для восстановления пароля — Симметрика',
    intro: 'Кто-то (надеемся, вы) попросил сбросить пароль от Симметрики. Введите этот код в окне входа:',
    ignore: 'Если вы не запрашивали сброс — просто проигнорируйте письмо: пароль останется прежним.',
  },
};

/** A letter with a one-time code (email check, password reset). */
export function codeLetter(options: { to: string; name: string; code: string; purpose: 'verify' | 'reset'; appUrl?: string }): Letter {
  const name = escapeHtml(options.name || 'коллега');
  const { subject, intro, ignore } = LETTERS[options.purpose];
  const html = frame(
    subject,
    `    <tr><td style="padding:22px 28px 0;font-size:14px;line-height:1.5;color:#1e1e1e;">
      Здравствуйте, ${name}!<br>${escapeHtml(intro)}
    </td></tr>
    <tr><td style="padding:18px 28px;">
      <div style="padding:14px 0;border:1px solid #4f5bd5;border-radius:8px;background:#eceefb;text-align:center;font-size:28px;font-weight:600;letter-spacing:8px;color:#1e1e1e;font-family:'SF Mono',Menlo,Consolas,monospace;">${escapeHtml(options.code)}</div>
    </td></tr>
    <tr><td style="padding:0 28px 22px;font-size:12px;line-height:1.5;color:#6b6b6b;">
      Код действует 15 минут. ${escapeHtml(ignore)}
    </td></tr>`,
    options.appUrl,
  );
  const text = `Здравствуйте, ${options.name || 'коллега'}!\n${intro}\n\n${options.code}\n\nКод действует 15 минут. ${ignore}\n\nСимметрика${options.appUrl ? ` — ${options.appUrl}` : ''}`;
  return { to: options.to, subject, html, text };
}

const SHARE_ROLES: Record<string, string> = { editor: 'редактировать', commenter: 'смотреть и комментировать', viewer: 'смотреть' };

/** "You have access to this resource": the name and a link that opens it. */
export function shareLetter(options: { to: string; inviter: string; fileName: string; role: string; url: string; needsAccount: boolean; appUrl?: string }): Letter {
  const subject = `Вам предоставлен доступ к «${options.fileName}»`;
  const can = SHARE_ROLES[options.role] ?? 'смотреть';
  const signUp = options.needsAccount ? `Чтобы открыть ресурс, войдите в Симметрику с адресом ${options.to}. Приглашение действует 30 дней.` : '';
  const html = frame(
    subject,
    `    <tr><td style="padding:22px 28px 0;font-size:14px;line-height:1.5;color:#1e1e1e;">
      Вам предоставлен доступ к ресурсу <strong>${escapeHtml(options.fileName)}</strong>.
    </td></tr>
    <tr><td style="padding:8px 28px 0;font-size:13px;line-height:1.5;color:#6b6b6b;">
      ${escapeHtml(options.inviter)} открыл доступ. Вы можете ${escapeHtml(can)}.
    </td></tr>
    <tr><td style="padding:18px 28px 0;">
      <a href="${escapeHtml(options.url)}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#4f5bd5;color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;">Открыть</a>
    </td></tr>
    <tr><td style="padding:12px 28px 0;font-size:12px;line-height:1.5;color:#6b6b6b;">
      <a href="${escapeHtml(options.url)}" style="color:#1e1e1e;">${escapeHtml(options.url)}</a>
    </td></tr>
    <tr><td style="padding:16px 28px 22px;font-size:12px;line-height:1.5;color:#6b6b6b;">
      ${escapeHtml(signUp || 'Ресурс появится на главной странице Симметрики в разделе «Доступные мне».')}
    </td></tr>`,
    options.appUrl,
  );
  const text = `Вам предоставлен доступ к ресурсу «${options.fileName}».\n\n${options.url}\n\n${options.inviter} открыл доступ. Вы можете ${can}.\n\n${signUp || 'Ресурс появится на главной странице Симметрики в разделе «Доступные мне».'}\n\nСимметрика${options.appUrl ? ` — ${options.appUrl}` : ''}`;
  return { to: options.to, subject, html, text };
}

const TEAM_ROLES: Record<string, string> = {
  admin: 'править все файлы команды и приглашать людей',
  editor: 'править все файлы команды',
  commenter: 'смотреть и комментировать файлы команды',
  viewer: 'смотреть файлы команды',
};

/** "N added you to a team": what the role allows and where the team's files are. */
export function teamLetter(options: { to: string; inviter: string; teamName: string; role: string; url: string; needsAccount: boolean; appUrl?: string }): Letter {
  const subject = `${options.inviter} пригласил(а) вас в команду «${options.teamName}» — Симметрика`;
  const can = TEAM_ROLES[options.role] ?? TEAM_ROLES.viewer!;
  const where = 'Проекты команды появятся на главной странице Симметрики, слева под её названием.';
  const signUp = options.needsAccount ? `Чтобы войти в команду, зарегистрируйтесь в Симметрике с этим адресом (${options.to}) — вы окажетесь в ней сами. Приглашение действует 30 дней.` : '';
  const html = frame(
    subject,
    `    <tr><td style="padding:22px 28px 0;font-size:14px;line-height:1.5;color:#1e1e1e;">
      <strong>${escapeHtml(options.inviter)}</strong> пригласил(а) вас в команду
    </td></tr>
    <tr><td style="padding:14px 28px 0;">
      <div style="padding:14px 16px;border:1px solid #e6e6e6;border-radius:8px;background:#f5f5f5;">
        <div style="font-size:15px;font-weight:600;color:#1e1e1e;">${escapeHtml(options.teamName)}</div>
        <div style="padding-top:4px;font-size:12px;color:#6b6b6b;">Вы можете ${escapeHtml(can)}</div>
      </div>
    </td></tr>
    <tr><td style="padding:18px 28px 0;">
      <a href="${escapeHtml(options.url)}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#4f5bd5;color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;">Открыть Симметрику</a>
    </td></tr>
    <tr><td style="padding:16px 28px 22px;font-size:12px;line-height:1.5;color:#6b6b6b;">
      ${escapeHtml(signUp || where)}
    </td></tr>`,
    options.appUrl,
  );
  const text = `${options.inviter} пригласил(а) вас в команду «${options.teamName}» — вы можете ${can}.\n\nОткрыть: ${options.url}\n\n${signUp || where}\n\nСимметрика${options.appUrl ? ` — ${options.appUrl}` : ''}`;
  return { to: options.to, subject, html, text };
}

/**
 * A new comment: someone called the person with @, answered in a discussion
 * they wrote in, or started one in their file. The text is quoted (cut to a
 * few lines), the button opens the file at the discussion.
 */
export function commentLetter(options: { to: string; author: string; fileName: string; text: string; url: string; kind: 'mention' | 'reply' | 'new' | 'board'; appUrl?: string }): Letter {
  const subjects = {
    mention: `${options.author} упомянул(а) вас в «${options.fileName}» — Симметрика`,
    reply: `${options.author} ответил(а) в обсуждении «${options.fileName}» — Симметрика`,
    new: `${options.author} оставил(а) комментарий в «${options.fileName}» — Симметрика`,
    board: `${options.author} упомянул(а) вас на доске «${options.fileName}» — Симметрика`,
  };
  const intros = { mention: 'упомянул(а) вас в комментарии к файлу', reply: 'ответил(а) в обсуждении файла', new: 'оставил(а) комментарий в вашем файле', board: 'упомянул(а) вас на доске' };
  // A mention in a sticker or a text of a board: the button opens the board at that object.
  const button = options.kind === 'board' ? 'Открыть доску' : 'Открыть обсуждение';
  const subject = subjects[options.kind];
  const quote = options.text.length > 600 ? `${options.text.slice(0, 600).trimEnd()}…` : options.text;
  const note = 'Какие письма о комментариях и упоминаниях присылать, можно выбрать в настройках Симметрики.';
  const html = frame(
    subject,
    `    <tr><td style="padding:22px 28px 0;font-size:14px;line-height:1.5;color:#1e1e1e;">
      <strong>${escapeHtml(options.author)}</strong> ${intros[options.kind]} <strong>${escapeHtml(options.fileName)}</strong>
    </td></tr>
    <tr><td style="padding:14px 28px 0;">
      <div style="padding:12px 14px;border-left:3px solid #4f5bd5;border-radius:4px;background:#f5f5f5;font-size:13px;line-height:1.5;color:#1e1e1e;white-space:pre-wrap;">${escapeHtml(quote)}</div>
    </td></tr>
    <tr><td style="padding:18px 28px 0;">
      <a href="${escapeHtml(options.url)}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#4f5bd5;color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;">${button}</a>
    </td></tr>
    <tr><td style="padding:16px 28px 22px;font-size:12px;line-height:1.5;color:#6b6b6b;">
      ${escapeHtml(note)}
    </td></tr>`,
    options.appUrl,
  );
  const text = `${options.author} ${intros[options.kind]} «${options.fileName}»:\n\n${quote}\n\n${button}: ${options.url}\n\n${note}\n\nСимметрика${options.appUrl ? ` — ${options.appUrl}` : ''}`;
  return { to: options.to, subject, html, text };
}

/** "N asks you to review a branch" (FR-BR-003): what the branch is and the button to open it. */
export function reviewLetter(options: { to: string; author: string; branchName: string; mainName: string; description: string; url: string; appUrl?: string }): Letter {
  const subject = `${options.author} просит посмотреть ветку «${options.branchName}» — Симметрика`;
  const html = frame(
    subject,
    `    <tr><td style="padding:22px 28px 0;font-size:14px;line-height:1.5;color:#1e1e1e;">
      <strong>${escapeHtml(options.author)}</strong> просит посмотреть изменения в ветке файла «${escapeHtml(options.mainName)}»
    </td></tr>
    <tr><td style="padding:14px 28px 0;">
      <div style="padding:14px 16px;border:1px solid #e6e6e6;border-radius:8px;background:#f5f5f5;">
        <div style="font-size:15px;font-weight:600;color:#1e1e1e;">${escapeHtml(options.branchName)}</div>
        ${options.description ? `<div style="padding-top:6px;font-size:13px;line-height:1.5;color:#1e1e1e;white-space:pre-wrap;">${escapeHtml(options.description)}</div>` : ''}
      </div>
    </td></tr>
    <tr><td style="padding:18px 28px 0;">
      <a href="${escapeHtml(options.url)}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#4f5bd5;color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;">Открыть ветку</a>
    </td></tr>
    <tr><td style="padding:16px 28px 22px;font-size:12px;line-height:1.5;color:#6b6b6b;">
      В ветке вверху — «Изменения»: что поменялось по сравнению с основным файлом. Комментируйте прямо на холсте, а потом нажмите «Одобрить» или «Нужны правки».
    </td></tr>`,
    options.appUrl,
  );
  const text = `${options.author} просит посмотреть ветку «${options.branchName}» файла «${options.mainName}».\n${options.description ? `\n${options.description}\n` : ''}\nОткрыть: ${options.url}\n\nСимметрика${options.appUrl ? ` — ${options.appUrl}` : ''}`;
  return { to: options.to, subject, html, text };
}

/** The reviewer's answer to the author of the branch: approved, or changes needed (with what). */
export function verdictLetter(options: { to: string; reviewer: string; branchName: string; approved: boolean; note: string; url: string; appUrl?: string }): Letter {
  const subject = options.approved ? `${options.reviewer} одобрил(а) ветку «${options.branchName}» — Симметрика` : `${options.reviewer} просит доработать ветку «${options.branchName}» — Симметрика`;
  const html = frame(
    subject,
    `    <tr><td style="padding:22px 28px 0;font-size:14px;line-height:1.5;color:#1e1e1e;">
      <strong>${escapeHtml(options.reviewer)}</strong> ${options.approved ? 'одобрил(а)' : 'просит доработать'} ветку «${escapeHtml(options.branchName)}»
    </td></tr>
    ${options.note ? `<tr><td style="padding:14px 28px 0;"><div style="padding:12px 14px;border-left:3px solid #4f5bd5;border-radius:4px;background:#f5f5f5;font-size:13px;line-height:1.5;color:#1e1e1e;white-space:pre-wrap;">${escapeHtml(options.note)}</div></td></tr>` : ''}
    <tr><td style="padding:18px 28px 22px;">
      <a href="${escapeHtml(options.url)}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#4f5bd5;color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;">Открыть ветку</a>
    </td></tr>`,
    options.appUrl,
  );
  const text = `${subject.replace(' — Симметрика', '')}.${options.note ? `\n\n${options.note}` : ''}\n\nОткрыть: ${options.url}\n\nСимметрика${options.appUrl ? ` — ${options.appUrl}` : ''}`;
  return { to: options.to, subject, html, text };
}
