from app.password_reset import PasswordResetError, confirm_password_reset, generate_code
from app.password_reset_mail import reset_code_email_html, reset_code_email_text


def test_generate_code_is_six_digits():
    code = generate_code()
    assert len(code) == 6
    assert code.isdigit()


def test_reset_email_contains_code():
    html = reset_code_email_html(code="482913")
    text = reset_code_email_text(code="482913")
    assert "482913" in html
    assert "#FF3495" in html
    assert "#16D5DF" in html
    assert "482913" in text


def test_confirm_rejects_mismatched_passwords():
    try:
        confirm_password_reset(
            None,  # type: ignore[arg-type]
            email="user@example.com",
            code="123456",
            new_login="user@example.com",
            new_password="longenough",
            new_password_repeat="different1",
        )
    except PasswordResetError as exc:
        assert exc.message == "Пароли не совпадают."
    else:
        raise AssertionError("expected mismatch")
