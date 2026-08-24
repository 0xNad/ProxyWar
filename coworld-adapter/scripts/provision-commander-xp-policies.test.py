#!/usr/bin/env python3
"""Runtime-safe receipt projection test for the pinned Coworld provisioner."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
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


def fixture_args(output: Path, recovery: Path | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        image="ghcr.io/0xnad/proxywar-commander-xp-policy@sha256:" + "1" * 64,
        name_prefix="proxywar-commander-xp-fixture",
        bedrock_model="us.anthropic.claude-sonnet-4-6",
        source_sha="2" * 40,
        source_tree_sha="3" * 40,
        source_provenance_digest="sha256:" + "4" * 64,
        build_provenance_digest="sha256:" + "5" * 64,
        oci_digest="sha256:" + "1" * 64,
        output=output,
        recovery=recovery,
        allow_remote_adoption=False,
    )


def fixture_policy(args: SimpleNamespace, role: str) -> dict[str, object]:
    name = MODULE.policy_name(args.name_prefix, role)
    return {
        "name": name,
        "role": role,
        "runArgv": MODULE.role_argv(role),
        "useBedrock": role in {"A", "B", "C"},
        "bedrockModel": args.bedrock_model if role in {"A", "B", "C"} else None,
        "environmentConfiguration": {
            "attached": role in {"A", "B", "C"},
            "keys": [],
            "valuesSha256": "6" * 64,
            "attachmentResponseSha256": None,
        },
        "creationMode": "immediate-response",
        "plannedCompletionPayloadProjection": {},
        "completionPayloadSha256": MODULE.sha256_bytes(MODULE.canonical_bytes({})),
        "completionPayloadAuthority": "coworld-request-sent-and-responded-v1",
        "completionResponse": {
            "id": f"pvid_{role.lower()}",
            "name": name,
            "version": 1,
            "pools": None,
            "submit_error": None,
        },
        "completionResponseAuthority": "coworld-immediate-completion-response-v1",
        "completionResponseSha256": "8" * 64,
        "completionResponseBytes": 1,
        "readback": {"id": f"pvid_{role.lower()}", "name": name, "version": 1},
        "readbackSha256": "9" * 64,
    }


class PolicyProvisionReceiptTest(unittest.TestCase):
    def test_coworld_0_1_42_create_request_preserves_exact_json_body(self) -> None:
        body = {
            "name": "commander-xp-fixture",
            "game": {"name": "proxywar-commander-xp-eval-v2"},
            "game_config": {
                "commander_xp_run_key": "cxp_fixture_preflight_a_0001",
                "seed": 12345,
            },
            "participants": [
                {"policy_version_id": "pvid_fixture_a", "position": 0},
                {"policy_version_id": "pvid_fixture_o1", "position": 1},
            ],
        }
        client = object.__new__(MODULE.CoworldApiClient)
        sentinel = object()
        with patch.object(client, "_post", return_value=sentinel) as post:
            result = client.create_experience_request(body)

        self.assertIs(result, sentinel)
        args, kwargs = post.call_args
        self.assertEqual(args[0], "/v2/experience-requests")
        self.assertEqual(args[1].__name__, "ExperienceRequestDetail")
        self.assertEqual(kwargs, {"json": body, "timeout": 120.0})
        self.assertEqual(
            MODULE.canonical_bytes(kwargs["json"]),
            MODULE.canonical_bytes(body),
        )

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
            MODULE.sha256_bytes(
                    MODULE.canonical_bytes(
                        receipt["plannedCompletionPayloadProjection"]
                    )
            ),
        )
        self.assertEqual(
            receipt["environmentConfiguration"],
            {
                "attached": True,
                "keys": ["providerRegion", "modelID", "providerEnabled"],
                "valuesSha256": MODULE.sha256_bytes(
                    MODULE.canonical_bytes(
                        {
                            "AWS_REGION": "us-west-2",
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

    def test_partial_policy_boundary_adopts_exact_receipts_and_creates_only_unseen_roles(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            recovery = root / "recovery"
            recovery.mkdir()
            output = root / "output"
            args = fixture_args(output, recovery)
            image = {"id": "img_fixture", "image_digest": args.oci_digest}
            image_upload = {"image": image, "requestPayloadSha256": "a" * 64}
            image_body = {
                "schemaVersion": 2,
                "authority": "coworld-0.1.42-policy-image-upload-v2",
                "inspectedAt": "2026-08-23T00:00:00Z",
                "platform": MODULE.PLATFORM,
                "sourceSha": args.source_sha,
                "sourceTreeSha": args.source_tree_sha,
                "sourceProvenanceDigest": args.source_provenance_digest,
                "buildProvenanceDigest": args.build_provenance_digest,
                "ociImage": args.image.split("@", 1)[0],
                "ociDigest": args.oci_digest,
                "containerImage": image,
                "imageUpload": image_upload,
            }
            MODULE.write_receipt(recovery / "image.json", image_body)
            common = {
                **image_body,
                "schemaVersion": 3,
                "authority": "coworld-0.1.42-policy-upload-readback-v3",
            }
            MODULE.write_receipt(
                recovery / "A.json", {**common, "policy": fixture_policy(args, "A")}
            )
            created: list[str] = []

            class RecoveryReadClient:
                def __enter__(self) -> RecoveryReadClient:
                    return self

                def __exit__(self, *_: object) -> None:
                    return None

                def lookup_policy_version(
                    self, *, name: str, version: int | None = None
                ) -> SimpleNamespace | None:
                    if name.endswith("-a") and version == 1:
                        return SimpleNamespace(id="pvid_a", name=name, version=1)
                    return None

            def create_policy(*_: object, role: str, **__: object) -> dict[str, object]:
                created.append(role)
                return fixture_policy(args, role)

            with (
                patch.object(
                    MODULE.CoworldApiClient,
                    "from_login",
                    return_value=RecoveryReadClient(),
                ),
                patch.object(
                    MODULE.CoworldUploadClient,
                    "from_login",
                    return_value=RecoveryReadClient(),
                ),
                patch.object(MODULE, "create_policy", side_effect=create_policy),
            ):
                MODULE.upload(args)

            self.assertEqual(created, list(MODULE.ROLES[1:]))
            self.assertEqual(
                sorted(path.name for path in output.iterdir()),
                [
                    "A.json",
                    "B.json",
                    "C.json",
                    "image.json",
                    "opponent-1.json",
                    "opponent-2.json",
                    "opponent-3.json",
                    "policy-identities-v2.json",
                ],
            )
            self.assertEqual(
                MODULE.read_receipt(output / "A.json")["policy"][
                    "completionResponse"
                ]["id"],
                "pvid_a",
            )

    def test_missing_policy_receipt_adopts_only_under_explicit_recovery_authority(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            recovery = root / "recovery"
            recovery.mkdir()
            output = root / "output"
            args = fixture_args(output, recovery)
            image = {"id": "img_fixture", "image_digest": args.oci_digest}
            MODULE.write_receipt(
                recovery / "image.json",
                {
                    "schemaVersion": 2,
                    "authority": "coworld-0.1.42-policy-image-upload-v2",
                    "inspectedAt": "2026-08-23T00:00:00Z",
                    "platform": MODULE.PLATFORM,
                    "sourceSha": args.source_sha,
                    "sourceTreeSha": args.source_tree_sha,
                    "sourceProvenanceDigest": args.source_provenance_digest,
                    "buildProvenanceDigest": args.build_provenance_digest,
                    "ociImage": args.image.split("@", 1)[0],
                    "ociDigest": args.oci_digest,
                    "containerImage": image,
                    "imageUpload": {"image": image},
                },
            )
            class ExistingReadClient:
                def __enter__(self) -> ExistingReadClient:
                    return self

                def __exit__(self, *_: object) -> None:
                    return None

                def lookup_policy_version(
                    self, *, name: str, version: int | None = None
                ) -> SimpleNamespace:
                    return SimpleNamespace(id=f"pvid_{name[-1]}", name=name, version=1)

            with patch.object(
                MODULE.CoworldApiClient,
                "from_login",
                return_value=ExistingReadClient(),
            ):
                with self.assertRaisesRegex(RuntimeError, "without recovery authority"):
                    MODULE.upload(args)

            output = root / "adopted-output"
            args = fixture_args(output, recovery)
            args.allow_remote_adoption = True
            with (
                patch.object(
                    MODULE.CoworldApiClient,
                    "from_login",
                    return_value=ExistingReadClient(),
                ),
                patch.object(
                    MODULE,
                    "create_policy",
                    side_effect=AssertionError("remote adoption must not recreate"),
                ),
            ):
                MODULE.upload(args)
            adopted = MODULE.read_receipt(output / "A.json")["policy"]
            self.assertEqual(
                adopted["creationMode"], "adopted-after-remote-success"
            )
            self.assertEqual(
                adopted["completionResponseAuthority"],
                "coworld-current-policy-version-readback-v1",
            )
            self.assertIsNone(
                adopted["environmentConfiguration"]["attachmentResponseSha256"]
            )


if __name__ == "__main__":
    unittest.main()
