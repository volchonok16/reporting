"""Письма сброса пароля через SMTP (mail.alexol.io и любой другой ящик)."""

from __future__ import annotations

import smtplib
from email.message import EmailMessage
from pathlib import Path

from app.config import settings

LOGO_PATH = Path(__file__).resolve().parents[1] / "assets" / "t2-b2b-logo-black.png"
LOGO_CID = "t2-b2b-logo"


class MailNotConfigured(RuntimeError):
    pass


class MailSendError(RuntimeError):
    pass


def smtp_configured() -> bool:
    return bool(settings.smtp_host.strip() and settings.smtp_from.strip())


def reset_code_email_html(*, code: str) -> str:
    cell = (
        "<td style=\"width:44px;height:52px;border:1px solid #000000;border-radius:10px;"
        "text-align:center;vertical-align:middle;font-family:Arial,Helvetica,sans-serif;"
        "font-size:24px;font-weight:700;color:#000000;background:#ffffff;\">{digit}</td>"
    )
    gap = '<td style="width:8px;font-size:0;line-height:0;">&nbsp;</td>'
    cells = gap.join(cell.format(digit=digit) for digit in code)
    logo = (
        f'<img src="cid:{LOGO_CID}" alt="t2 Бизнес" height="36" '
        'style="display:block;height:36px;width:auto;border:0;">'
        if LOGO_PATH.is_file()
        else (
            '<span style="display:inline-block;width:10px;height:10px;background:#FF3495;'
            'margin-right:8px;"></span>'
            '<span style="font-family:Arial,Helvetica,sans-serif;font-size:22px;'
            'font-weight:700;letter-spacing:0.04em;color:#000000;">t2</span>'
        )
    )
    return f"""<!DOCTYPE html>
<html lang="ru">
<body style="margin:0;padding:0;background:#ffffff;color:#000000;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border:1px solid #e6e6e6;">
          <tr>
            <td style="padding:24px 28px 16px;">{logo}</td>
          </tr>
          <tr>
            <td style="height:4px;background:#16D5DF;font-size:0;line-height:0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:28px 28px 8px;font-family:Arial,Helvetica,sans-serif;font-size:22px;line-height:1.2;font-weight:700;color:#000000;">
              Сброс пароля
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 20px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#000000;">
              Кто-то запросил смену пароля для этой учётной записи. Введите код на странице входа.
              Код действует 15 минут и только один раз.
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 8px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>{cells}</tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 4px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#333333;">
              Код: {code}
            </td>
          </tr>
          <tr>
            <td style="padding:12px 28px 28px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#333333;">
              Если вы не запрашивали сброс, ничего делать не нужно — пароль не изменится.
            </td>
          </tr>
          <tr>
            <td style="height:4px;background:#FF3495;font-size:0;line-height:0;">&nbsp;</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""


def reset_code_email_text(*, code: str) -> str:
    return (
        "Сброс пароля t2 B2B\n\n"
        f"Код подтверждения: {code}\n"
        "Код действует 15 минут и только один раз.\n"
        "Если вы не запрашивали сброс, проигнорируйте это письмо.\n"
    )


def send_reset_code(*, to_email: str, code: str) -> None:
    if not smtp_configured():
        raise MailNotConfigured("SMTP не настроен")
    sender = settings.smtp_from.strip()
    message = EmailMessage()
    message["Subject"] = "Код для сброса пароля"
    message["From"] = sender
    message["To"] = to_email
    message.set_content(reset_code_email_text(code=code))
    message.add_alternative(reset_code_email_html(code=code), subtype="html")
    if LOGO_PATH.is_file():
        logo = LOGO_PATH.read_bytes()
        message.get_payload()[1].add_related(
            logo,
            maintype="image",
            subtype="png",
            cid=f"<{LOGO_CID}>",
        )

    host = settings.smtp_host.strip()
    port = int(settings.smtp_port)
    try:
        if settings.smtp_use_ssl:
            client: smtplib.SMTP = smtplib.SMTP_SSL(host, port, timeout=20)
        else:
            client = smtplib.SMTP(host, port, timeout=20)
        with client:
            client.ehlo()
            if settings.smtp_starttls and not settings.smtp_use_ssl:
                client.starttls()
                client.ehlo()
            user = settings.smtp_user.strip()
            if user:
                client.login(user, settings.smtp_password)
            client.send_message(message)
    except MailNotConfigured:
        raise
    except Exception as exc:
        raise MailSendError("Не удалось отправить письмо") from exc
