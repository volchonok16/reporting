from app.password_reset_mail import status_office_admin_unlock_email_text


def test_admin_unlock_mail_names_admin_and_office() -> None:
    text = status_office_admin_unlock_email_text(
        admin_name="Иванов Иван",
        office_name="Офис: CORE",
    )
    assert "Иванов Иван" in text
    assert "Офис: CORE" in text
    assert "к которому он принадлежит" in text
