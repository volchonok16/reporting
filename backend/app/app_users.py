import secrets


def parse_app_users(raw: str) -> dict[str, str]:
    """Пары login:password из APP_AUTH_USERS (строки через перевод строки или запятую)."""
    users: dict[str, str] = {}
    for line in raw.replace(",", "\n").splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        login, _, password = line.partition(":")
        login = login.strip()
        password = password.strip()
        if login and password:
            users[login.casefold()] = password
    return users


def verify_app_user(users: dict[str, str], username: str, password: str) -> bool:
    expected = users.get(username.strip().casefold())
    if not expected:
        return False
    return secrets.compare_digest(expected, password)
