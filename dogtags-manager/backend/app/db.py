from fastapi import Request
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


def make_engine(database_url, **kwargs):
    return create_engine(database_url, hide_parameters=True, pool_pre_ping=True, **kwargs)


def make_session_factory(engine):
    return sessionmaker(engine, expire_on_commit=False)


def get_db(request: Request):
    with request.app.state.sessions() as session:
        yield session
