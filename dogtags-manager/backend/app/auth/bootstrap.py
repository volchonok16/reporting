"""python -m app.auth.bootstrap ACCOUNT — password is read privately, never an argument."""
import argparse
import getpass

from sqlalchemy.exc import SQLAlchemyError

from app.auth.accounts import create_account
from app.db import make_engine, make_session_factory
from app.settings import Settings


def main():
    parser = argparse.ArgumentParser(description="Create a local DOGTAGS MANAGER operator.")
    parser.add_argument("username")
    arguments = parser.parse_args()
    password = getpass.getpass("Password: ")
    confirmation = getpass.getpass("Repeat password: ")
    if not password or password != confirmation:
        parser.exit(1, "Passwords must be nonempty and match.\n")
    engine = make_engine(Settings.from_environment().database_url)
    try:
        with make_session_factory(engine)() as db:
            create_account(db, arguments.username, password)
            db.commit()
    except (ValueError, SQLAlchemyError):
        parser.exit(1, "Account creation failed. Check the account name and database availability.\n")
    finally:
        engine.dispose()
    print("Local account created.")


if __name__ == "__main__":
    main()
