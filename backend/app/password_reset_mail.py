"""Письма сброса пароля и напоминания о статусе через SMTP."""

from __future__ import annotations

import smtplib
from datetime import date, timedelta
from html import escape
from email.message import EmailMessage
from pathlib import Path

from app.config import settings

LOGO_PATH = Path(__file__).resolve().parents[1] / "assets" / "t2-b2b-logo-black.png"
LOGO_CID = "t2-b2b-logo"
STATUS_PAGE_URL = "http://t2product.ru/?sheet=product-status-b2b"

_RU_MONTHS = (
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
)


class MailNotConfigured(RuntimeError):
    pass


class MailSendError(RuntimeError):
    pass


def smtp_configured() -> bool:
    return bool(settings.smtp_host.strip() and settings.smtp_from.strip())


def format_ru_day_month(value: date) -> str:
    return f"{value.day} {_RU_MONTHS[value.month - 1]}"


def _logo_html(src: str, *, height: int = 36) -> str:
    # Пропорция как у BrandLogo на странице входа: SVG 920×276.
    width = round(height * (920 / 276))
    if src or LOGO_PATH.is_file():
        return (
            f'<img src="{src or f"cid:{LOGO_CID}"}" alt="t2 Бизнес" '
            f'height="{height}" width="{width}" '
            f'style="display:block;height:{height}px;width:{width}px;border:0;">'
        )
    return (
        '<span style="display:inline-block;width:10px;height:10px;background:#FF3495;'
        'margin-right:8px;"></span>'
        '<span style="font-family:Arial,Helvetica,sans-serif;font-size:22px;'
        'font-weight:700;letter-spacing:0.04em;color:#000000;">t2</span>'
    )


def _status_button_html() -> str:
    return f"""
          <tr>
            <td align="center" style="padding:0 28px 28px;text-align:center;">
              <a href="{STATUS_PAGE_URL}"
                 style="display:inline-block;padding:16px 40px;background-color:#E6F5FB;color:#000000;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;text-decoration:none;border:2px solid #000000;border-radius:999px;">
                Перейти к статусу
              </a>
            </td>
          </tr>"""


def _email_shell(*, title: str, body: str, logo_src: str = "") -> str:
    logo = _logo_html(logo_src)
    return f"""<!DOCTYPE html>
<html lang="ru">
<head><meta charset="utf-8"></head>
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
              {title}
            </td>
          </tr>
          {body}
          <tr>
            <td style="height:4px;background:#FF3495;font-size:0;line-height:0;">&nbsp;</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""


def reset_code_email_html(*, code: str, logo_src: str = "") -> str:
    cell = (
        "<td style=\"width:44px;height:52px;border:1px solid #000000;border-radius:10px;"
        "text-align:center;vertical-align:middle;font-family:Arial,Helvetica,sans-serif;"
        "font-size:24px;font-weight:700;color:#000000;background:#ffffff;\">{digit}</td>"
    )
    gap = '<td style="width:8px;font-size:0;line-height:0;">&nbsp;</td>'
    cells = gap.join(cell.format(digit=digit) for digit in code)
    body = f"""
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
          </tr>"""
    return _email_shell(title="Сброс пароля", body=body, logo_src=logo_src)


def _signature_html(logo_src: str) -> str:
    signature_logo = _logo_html(logo_src, height=44)
    return f"""
          <tr>
            <td style="padding:0 28px 4px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.3;font-weight:700;color:#000000;">
              t2 продукт
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.4;color:#000000;">
              Менеджеры проектного офиса
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 16px;">{signature_logo}</td>
          </tr>
          <tr>
            <td style="padding:0 28px 28px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#000000;">
              ООО «Т2 Мобайл», г. Москва<br>
              Киевское шоссе, 22-й км., д.6, стр.1
            </td>
          </tr>"""


def status_office_lock_soon_email_html(*, office_name: str, logo_src: str = "") -> str:
    safe_name = escape(office_name)
    body = f"""
          <tr>
            <td style="padding:8px 28px 24px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#000000;">
              Добрый день.
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 28px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#000000;">
              «{safe_name}» заблокируется для внесения статуса через 30 минут.
            </td>
          </tr>
          {_status_button_html()}
          {_signature_html(logo_src)}"""
    return _email_shell(title="Офис заблокируется через 30 минут", body=body, logo_src=logo_src)


def status_office_lock_soon_email_text(*, office_name: str) -> str:
    return (
        "Офис заблокируется через 30 минут\n\n"
        "Добрый день.\n\n"
        f"«{office_name}» заблокируется для внесения статуса через 30 минут.\n"
        f"Перейти к статусу: {STATUS_PAGE_URL}\n\n"
        "t2 продукт\n"
        "Менеджеры проектного офиса\n"
        "ООО «Т2 Мобайл», г. Москва\n"
        "Киевское шоссе, 22-й км., д.6, стр.1\n"
    )


def status_office_lock_state_email_html(
    *,
    office_name: str,
    locked: bool,
    logo_src: str = "",
) -> str:
    safe_name = escape(office_name)
    if locked:
        title = "Офис заблокирован"
        message = (
            f"«{safe_name}» заблокирован для внесения статуса. "
            "Для разблокировки обратитесь к Склярову Ивану или Тараскину Александру."
        )
    else:
        title = "Офис разблокирован"
        message = f"«{safe_name}» разблокирован для внесения статуса."
    body = f"""
          <tr>
            <td style="padding:8px 28px 24px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#000000;">
              Добрый день.
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 28px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#000000;">
              {message}
            </td>
          </tr>
          {_status_button_html()}
          {_signature_html(logo_src)}"""
    return _email_shell(title=title, body=body, logo_src=logo_src)


def status_office_lock_state_email_text(*, office_name: str, locked: bool) -> str:
    if locked:
        title = "Офис заблокирован"
        message = (
            f"«{office_name}» заблокирован для внесения статуса. "
            "Для разблокировки обратитесь к Склярову Ивану или Тараскину Александру."
        )
    else:
        title = "Офис разблокирован"
        message = f"«{office_name}» разблокирован для внесения статуса."
    return (
        f"{title}\n\n"
        "Добрый день.\n\n"
        f"{message}\n"
        f"Перейти к статусу: {STATUS_PAGE_URL}\n\n"
        "t2 продукт\n"
        "Менеджеры проектного офиса\n"
        "ООО «Т2 Мобайл», г. Москва\n"
        "Киевское шоссе, 22-й км., д.6, стр.1\n"
    )


def status_office_admin_unlock_email_html(
    *,
    admin_name: str,
    office_name: str,
    logo_src: str = "",
) -> str:
    safe_admin = escape(admin_name)
    safe_office = escape(office_name)
    message = (
        f"Администратор {safe_admin} разблокировал офис «{safe_office}», "
        "к которому он принадлежит."
    )
    body = f"""
          <tr>
            <td style="padding:8px 28px 24px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#000000;">
              Добрый день.
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 28px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#000000;">
              {message}
            </td>
          </tr>
          {_status_button_html()}
          {_signature_html(logo_src)}"""
    return _email_shell(title="Офис разблокирован администратором", body=body, logo_src=logo_src)


def status_office_admin_unlock_email_text(*, admin_name: str, office_name: str) -> str:
    return (
        "Офис разблокирован администратором\n\n"
        "Добрый день.\n\n"
        f"Администратор {admin_name} разблокировал офис «{office_name}», "
        "к которому он принадлежит.\n"
        f"Перейти к статусу: {STATUS_PAGE_URL}\n\n"
        "t2 продукт\n"
        "Менеджеры проектного офиса\n"
        "ООО «Т2 Мобайл», г. Москва\n"
        "Киевское шоссе, 22-й км., д.6, стр.1\n"
    )


def status_raffle_email_html(*, places: list[dict], logo_src: str = "") -> str:
    rows = []
    for item in places:
        members = ", ".join(item.get("members") or []) or "состав не задан"
        rows.append(
            "<tr>"
            f'<td style="padding:8px 12px;border-bottom:1px solid #000000;font-family:Arial,Helvetica,sans-serif;font-size:14px;">{escape(str(item["place"]))}</td>'
            f'<td style="padding:8px 12px;border-bottom:1px solid #000000;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;">{escape(str(item["name"]))}</td>'
            f'<td style="padding:8px 12px;border-bottom:1px solid #000000;font-family:Arial,Helvetica,sans-serif;font-size:14px;">{escape(str(item["points"]))}</td>'
            f'<td style="padding:8px 12px;border-bottom:1px solid #000000;font-family:Arial,Helvetica,sans-serif;font-size:13px;">{escape(members)}</td>'
            "</tr>"
        )
    table = "".join(rows) or (
        '<tr><td colspan="4" style="padding:8px 12px;font-family:Arial,Helvetica,sans-serif;">Пока нет офисов.</td></tr>'
    )
    body = f"""
          <tr>
            <td style="padding:8px 28px 16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#000000;">
              Добрый день. Итоги баллов офисов: первое место — больше баллов.
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 28px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                <tr>
                  <th align="left" style="padding:8px 12px;border-bottom:2px solid #000000;font-family:Arial,Helvetica,sans-serif;font-size:12px;">Место</th>
                  <th align="left" style="padding:8px 12px;border-bottom:2px solid #000000;font-family:Arial,Helvetica,sans-serif;font-size:12px;">Офис</th>
                  <th align="left" style="padding:8px 12px;border-bottom:2px solid #000000;font-family:Arial,Helvetica,sans-serif;font-size:12px;">Баллы</th>
                  <th align="left" style="padding:8px 12px;border-bottom:2px solid #000000;font-family:Arial,Helvetica,sans-serif;font-size:12px;">Состав</th>
                </tr>
                {table}
              </table>
            </td>
          </tr>
          {_status_button_html()}
          {_signature_html(logo_src)}"""
    return _email_shell(title="Итоги баллов офисов", body=body, logo_src=logo_src)


def status_raffle_email_text(*, places: list[dict]) -> str:
    lines = ["Итоги баллов офисов", "", "Добрый день.", ""]
    if not places:
        lines.append("Пока нет офисов.")
    for item in places:
        members = ", ".join(item.get("members") or []) or "состав не задан"
        lines.append(
            f"{item['place']} место. {item['name']}. {item['points']} баллов. Состав: {members}"
        )
    lines.extend(["", f"Перейти к статусу: {STATUS_PAGE_URL}", "", "t2 продукт", "Менеджеры проектного офиса"])
    return "\n".join(lines)


def status_locked_email_html(*, logo_src: str = "") -> str:
    body = f"""
          <tr>
            <td style="padding:8px 28px 24px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#000000;">
              Добрый день.
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 28px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#000000;">
              Коллеги, внесение статуса заблокировано.
              Для разблокировки обратитесь к Склярову Ивану или Тараскину Александру.
            </td>
          </tr>
          {_status_button_html()}
          {_signature_html(logo_src)}"""
    return _email_shell(title="Внесение статуса заблокировано", body=body, logo_src=logo_src)


def status_locked_email_text() -> str:
    return (
        "Внесение статуса заблокировано\n\n"
        "Добрый день.\n\n"
        "Коллеги, внесение статуса заблокировано. "
        "Для разблокировки обратитесь к Склярову Ивану или Тараскину Александру.\n"
        f"Перейти к статусу: {STATUS_PAGE_URL}\n\n"
        "t2 продукт\n"
        "Менеджеры проектного офиса\n"
        "ООО «Т2 Мобайл», г. Москва\n"
        "Киевское шоссе, 22-й км., д.6, стр.1\n"
    )


def status_reminder_email_html(*, today: date | None = None, logo_src: str = "") -> str:
    current = today or date.today()
    lock_day = current + timedelta(days=1)
    today_label = format_ru_day_month(current)
    lock_label = format_ru_day_month(lock_day)
    body = f"""
          <tr>
            <td style="padding:8px 28px 24px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#000000;">
              Добрый день.
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 28px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#000000;">
              Напоминаем: сегодня, {today_label}, до конца дня нужно внести статус продукта.
              С начала следующего дня, {lock_label}, внесение будет заблокировано.
            </td>
          </tr>
          {_status_button_html()}
          {_signature_html(logo_src)}"""
    return _email_shell(title="Напоминание", body=body, logo_src=logo_src)


def status_reminder_email_text(*, today: date | None = None) -> str:
    current = today or date.today()
    lock_day = current + timedelta(days=1)
    return (
        "Напоминание: внесите статус продукта\n\n"
        "Добрый день.\n\n"
        f"Напоминаем: сегодня, {format_ru_day_month(current)}, до конца дня нужно внести статус продукта. "
        f"С начала следующего дня, {format_ru_day_month(lock_day)}, внесение будет заблокировано.\n"
        f"Перейти к статусу: {STATUS_PAGE_URL}\n\n"
        "t2 продукт\n"
        "Менеджеры проектного офиса\n"
        "ООО «Т2 Мобайл», г. Москва\n"
        "Киевское шоссе, 22-й км., д.6, стр.1\n"
    )


def reset_code_email_text(*, code: str) -> str:
    return (
        "Сброс пароля t2 B2B\n\n"
        f"Код подтверждения: {code}\n"
        "Код действует 15 минут и только один раз.\n"
        "Если вы не запрашивали сброс, проигнорируйте это письмо.\n"
    )


def send_html_mail(*, to_email: str, subject: str, html: str, text: str) -> None:
    if not smtp_configured():
        raise MailNotConfigured("SMTP не настроен")
    sender = settings.smtp_from.strip()
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = sender
    message["To"] = to_email
    message.set_content(text)
    message.add_alternative(html, subtype="html")
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


def send_reset_code(*, to_email: str, code: str) -> None:
    send_html_mail(
        to_email=to_email,
        subject="Код для сброса пароля",
        html=reset_code_email_html(code=code),
        text=reset_code_email_text(code=code),
    )
