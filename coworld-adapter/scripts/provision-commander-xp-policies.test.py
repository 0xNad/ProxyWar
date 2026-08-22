#!/usr/bin/env python3
"""Runtime-safe receipt projection test for the pinned Coworld provisioner."""

from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("provision-commander-xp-policies.py")
SPEC = importlib.util.spec_from_file_location("commander_xp_policy_provision", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("unable to load Commander XP policy provisioner")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class FakeResponse:
    def __init__(self, body: dict[str, object]) -> None:
        self._body = body
        self.content = json.dumps(body, separators=(",", ":")).encode()

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, object]:
        return self._body


class FakeHttpClient:
    def __init__(self) -> None:
        self.completion_payload: dict[str, object] | None = None

    def post(self, path: str, *, json: dict[str, object], **_: object) -> FakeResponse:
        if path == "/stats/policy-secret-envs":
            return FakeResponse({"id": "pse_private_fixture"})
        if path == "/stats/policies/docker-img/complete":
            self.completion_payload = json
            return FakeResponse(
                {
                    "id": "pvid_fixture",
                    "name": json["name"],
                    "version": 1,
                    "pools": None,
                    "submit_error": None,
                }
            )
        raise AssertionError(f"unexpected endpoint: {path}")


class FakeUploadClient:
    def __init__(self) -> None:
        self._http_client = FakeHttpClient()

    def _headers(self) -> dict[str, str]:
        return {}


class FakeReadClient:
    def __enter__(self) -> FakeReadClient:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def lookup_policy_version(self, *, name: str, version: int) -> SimpleNamespace:
        return SimpleNamespace(id="pvid_fixture", name=name, version=version)


class PolicyProvisionReceiptTest(unittest.TestCase):
    def test_commander_upload_retains_only_the_safe_environment_projection(
        self,
    ) -> None:
        client = FakeUploadClient()
        with patch.object(
            MODULE.CoworldApiClient,
            "from_login",
            return_value=FakeReadClient(),
        ):
            receipt = MODULE.create_policy(
                client,
                prefix="proxywar-commander-xp-fixture",
                role="A",
                image_id="img_fixture",
                bedrock_model="us.anthropic.claude-sonnet-4-6",
            )

        payload = client._http_client.completion_payload
        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["policy_secret_env_id"], "pse_private_fixture")
        self.assertEqual(
            receipt["completionPayloadSha256"],
            MODULE.sha256_bytes(MODULE.canonical_bytes(payload)),
        )
        self.assertEqual(
            receipt["environmentConfiguration"],
            {
                "attached": True,
                "keys": ["BEDROCK_MODEL", "USE_BEDROCK"],
                "valuesSha256": MODULE.sha256_bytes(
                    MODULE.canonical_bytes(
                        {
                            "BEDROCK_MODEL": "us.anthropic.claude-sonnet-4-6",
                            "USE_BEDROCK": "true",
                        }
                    )
                ),
                "attachmentResponseSha256": receipt["environmentConfiguration"][
                    "attachmentResponseSha256"
                ],
            },
        )
        self.assertEqual(
            receipt["readback"],
            {"id": "pvid_fixture", "name": receipt["name"], "version": 1},
        )
        public_bytes = json.dumps(receipt, sort_keys=True)
        self.assertNotIn("pse_private_fixture", public_bytes)
        self.assertNotIn("policy_secret_env_id", public_bytes)
        self.assertNotIn('"secret', public_bytes.lower())
        self.assertNotIn('"presigned', public_bytes.lower())


if __name__ == "__main__":
    unittest.main()
