"""Validate, prove examples and atomically publish an immutable rule version."""
import argparse
import json
from contextlib import nullcontext

from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError

from app.auth.policy import require_rule_publication
from app.db import make_engine, make_session_factory
from app.domain.rules import profile_for, rules_snapshot, seed_config, validate_config, operator_value
from app.errors import ApiError
from app.models import ProcessingMnemonic, RulePublication, SourceProfileVersion, User
from app.settings import Settings


def publish_rules(db, author, data, *, reason):
    require_rule_publication(author)
    if not reason or not reason.strip() or len(reason) > 2000:
        raise ValueError('A nonempty publication reason up to 2000 characters is required.')
    snapshot = rules_snapshot(validate_config(data))
    # Serialize publications (including the first) for repeatable retries and active-version order.
    db.execute(text('SELECT pg_advisory_xact_lock(731946204)'))
    existing = db.scalar(select(RulePublication).where(RulePublication.version == snapshot['version']))
    if existing:
        if existing.digest != snapshot['digest']:
            raise ValueError('Published version names cannot be reused for changed content.')
        return existing
    publication = RulePublication(version=snapshot['version'], digest=snapshot['digest'],
                                  snapshot=snapshot, created_by=author.id, reason=reason.strip())
    db.add(publication)
    known = set(db.scalars(select(ProcessingMnemonic.code)))
    for partner in snapshot['config']['profiles']:
        code = snapshot['config']['profiles'][partner]['INTERNAL_OPERATOR_NAME']
        if operator_value(code) and code not in known:
            db.add(ProcessingMnemonic(code=code, description=partner))
            known.add(code)
        db.add(SourceProfileVersion(version=f"rules:{snapshot['digest']}:{partner}",
                                    config_hash=snapshot['digest'], snapshot=profile_for(snapshot, partner)))
    db.flush()
    return publication


def active_snapshot(db):
    row = db.scalar(select(RulePublication).order_by(RulePublication.publication_order.desc()).limit(1))
    return row.snapshot if row else None


def published_profile(db, snapshot, partner):
    profile = profile_for(snapshot, partner)
    row = db.scalar(select(SourceProfileVersion).where(
        SourceProfileVersion.version == f"rules:{snapshot['digest']}:{partner}"))
    if not row or row.config_hash != snapshot['digest'] or row.snapshot != profile:
        raise ValueError('Profile is not part of the selected published rule version.')
    return row


def main():
    parser = argparse.ArgumentParser(description='Publish DOGTAGS MANAGER immutable rules.')
    parser.add_argument('--grant-publisher', metavar='ACCOUNT')
    parser.add_argument('--author')
    parser.add_argument('--reason')
    source = parser.add_mutually_exclusive_group()
    source.add_argument('--seed', action='store_true')
    source.add_argument('--file')
    args = parser.parse_args()
    if args.grant_publisher:
        if args.author or args.reason or args.seed or args.file:
            parser.error('Granting a privilege is a separate administrator command.')
    elif not args.author or not args.reason or not (args.seed or args.file):
        parser.error('Publication requires --author, --reason and --seed or --file.')
    engine = make_engine(Settings.from_environment().database_url)
    try:
        with make_session_factory(engine)() as db:
            user = db.scalar(select(User).where(User.username == (args.grant_publisher or args.author)))
            if not user or not user.active:
                raise ValueError('Active account required.')
            if args.grant_publisher:
                user.permissions = sorted(set(user.permissions) | {'rules.publish'})
                result = 'Explicit rules.publish permission granted.'
            else:
                with open(args.file, encoding='utf-8') if args.file else nullcontext() as stream:
                    config = json.load(stream) if stream else seed_config()
                row = publish_rules(db, user, config, reason=args.reason)
                result = f'Published {row.version} sha256={row.digest}'
            db.commit()
    except (ValueError, OSError, SQLAlchemyError, ApiError) as error:
        # Never print DB exception parameters or connection details.
        parser.exit(1, f'Publication failed: {error if isinstance(error, ValueError) else type(error).__name__}\n')
    finally:
        engine.dispose()
    print(result)


if __name__ == '__main__':
    main()
