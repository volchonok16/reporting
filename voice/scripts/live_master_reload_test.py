#!/usr/bin/env python3
"""Verify that a live master analysis survives a client/page reload."""

from __future__ import annotations

import argparse
import time
import uuid
from pathlib import Path

import httpx

from backend.config import settings


def require_ok(response: httpx.Response) -> dict:
    response.raise_for_status()
    return response.json()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("file", type=Path)
    parser.add_argument("--api", default="http://localhost:8000")
    parser.add_argument("--email", default=settings.auth_bootstrap_email)
    parser.add_argument("--password", default=settings.auth_bootstrap_password)
    arguments = parser.parse_args()
    session_id = f"live-reload-{uuid.uuid4().hex}"

    with httpx.Client(base_url=arguments.api, timeout=180) as client:
        login = require_ok(
            client.post(
                "/api/auth/login",
                json={"email": arguments.email, "password": arguments.password},
            )
        )
        headers = {
            "Authorization": f"Bearer {login['token']}",
            "X-Session-ID": session_id,
        }
        require_ok(client.post("/api/master/lock", headers=headers))
        with arguments.file.open("rb") as source:
            upload = require_ok(
                client.post(
                    "/api/uploads",
                    headers=headers,
                    files={"file": (arguments.file.name, source, "text/csv")},
                )
            )
        queued = require_ok(
            client.post(
                "/api/master/imports/analyze",
                headers=headers,
                json={"uploadId": upload["id"], "mode": "auto"},
            )
        )

    # A brand-new client is the HTTP equivalent of reloading the page. The
    # durable session/import identifiers are the only state carried over.
    with httpx.Client(base_url=arguments.api, timeout=180) as reloaded:
        active = require_ok(
            reloaded.get("/api/master/imports/active", headers=headers)
        )["active"]
        if queued["status"] in {"queued", "analyzing"}:
            assert active is not None
            assert active["importId"] == queued["importId"]
        deadline = time.monotonic() + 180
        result = queued
        while result["status"] in {"queued", "analyzing"}:
            assert time.monotonic() < deadline, result
            time.sleep(0.25)
            result = require_ok(
                reloaded.get(
                    f"/api/master/imports/{queued['importId']}",
                    headers=headers,
                )
            )
        assert result["status"] == "analyzed", result
        require_ok(reloaded.delete("/api/master/lock", headers=headers))

    print(
        {
            "status": result["status"],
            "sourceRows": result["stats"]["sourceRows"],
            "uniqueA": result["stats"]["uniqueA"],
            "duplicateA": result["stats"]["duplicateA"],
            "invalidRows": result["stats"]["invalidRows"],
            "reloadRecovered": True,
        }
    )


if __name__ == "__main__":
    main()
