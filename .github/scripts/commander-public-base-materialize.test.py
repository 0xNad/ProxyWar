#!/usr/bin/env python3
"""Focused receipt and cardinality tests for public-base materialization."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


class FakeModel:
    @classmethod
    def model_validate(cls, value: object) -> object:
        return value


class PlaceholderReadClient:
    @classmethod
    def from_login(cls, **_: object) -> object:
        raise AssertionError("unexpected unpatched Coworld client")


class PlaceholderUploadClient:
    @classmethod
    def from_login(cls, **_: object) -> object:
        raise AssertionError("unexpected unpatched Coworld upload client")


coworld = types.ModuleType("coworld")
api_client = types.ModuleType("coworld.api_client")
upload = types.ModuleType("coworld.upload")
api_client.CoworldApiClient = PlaceholderReadClient
upload.ContainerImageResponse = FakeModel
upload.CoworldUploadClient = PlaceholderUploadClient
upload.ImageUploadResponse = FakeModel
upload.PolicyVersionResponse = FakeModel
upload._image_upload_name = lambda image: image.split("@", 1)[0].rsplit("/", 1)[1]
upload._local_image_client_hash = lambda _image: "sha256:" + "7" * 64
upload._push_container_image = lambda *_args: None
sys.modules["coworld"] = coworld
sys.modules["coworld.api_client"] = api_client
sys.modules["coworld.upload"] = upload

SCRIPT = Path(__file__).with_name("commander-public-base-materialize.py")
SPEC = importlib.util.spec_from_file_location(
    "commander_public_base_materialize", SCRIPT
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("unable to load Commander public-base materializer")
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
        self.requests: list[tuple[str, dict[str, object]]] = []

    def post(
        self, path: str, *, json: dict[str, object], **_: object
    ) -> FakeResponse:
        self.requests.append((path, json))
        if path != "/stats/policies/docker-img/complete":
            raise AssertionError(f"unexpected endpoint: {path}")
        return FakeResponse(
            {
                "id": "pvid_public_base_fixture",
                "name": json["name"],
                "version": 1,
                "pools": None,
                "submit_error": None,
            }
        )


class FakeUploadClient:
    def __init__(self) -> None:
        self._http_client = FakeHttpClient()

    def __enter__(self) -> "FakeUploadClient":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def _headers(self) -> dict[str, str]:
        return {}


class FakeReadClient:
    def __init__(self, policy: object | None) -> None:
        self.policy = policy

    def __enter__(self) -> "FakeReadClient":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def lookup_policy_version(self, **_: object) -> object | None:
        return self.policy


def fixture_args(output: Path, recovery: Path | None = None) -> SimpleNamespace:
    digest = "sha256:" + "1" * 64
    return SimpleNamespace(
        command="upload",
        image="ghcr.io/0xnad/proxywar-commander-public-base@" + digest,
        policy_name="proxywar-commander-public-base-" + "2" * 20,
        source_sha="2" * 40,
        source_tree_sha="3" * 40,
        source_provenance_digest="sha256:" + "4" * 64,
        build_provenance_digest="sha256:" + "5" * 64,
        oci_digest=digest,
        output=output,
        recovery=recovery,
    )


def fixture_image(args: SimpleNamespace) -> tuple[dict[str, object], dict[str, object]]:
    client_hash = "sha256:" + "7" * 64
    image = {
        "id": "img_public_base_fixture",
        "name": "proxywar-commander-public-base",
        "version": 1,
        "client_hash": client_hash,
        "status": "ready",
        "image_uri": None,
        "image_digest": "sha256:" + "8" * 64,
        "public_image_uri": "public.ecr.aws/example/cogames@sha256:" + "8" * 64,
    }
    request = {
        "name": MODULE._image_upload_name(args.image),
        "client_hash": client_hash,
    }
    image_upload = {
        "requestPayload": request,
        "requestPayloadSha256": MODULE.sha256_bytes(
            MODULE.canonical_bytes(request)
        ),
        "image": image,
    }
    return image, image_upload


class PublicBaseMaterializeTest(unittest.TestCase):
    def test_policy_payload_is_exactly_one_non_bedrock_materializer(self) -> None:
        payload = MODULE.policy_payload(
            policy_name="proxywar-commander-public-base-" + "a" * 20,
            image_id="img_fixture",
            source_sha="b" * 40,
            source_tree_sha="c" * 40,
        )
        self.assertEqual(
            payload["run"],
            ["node", "/app/proxywar/coworld-adapter/src/starter-player.mjs"],
        )
        self.assertEqual(
            payload["tags"]["purpose"],
            "commander-public-base-materialization-v1",
        )
        self.assertNotIn("policy_secret_env_id", payload)
        self.assertNotIn("BEDROCK_MODEL", json.dumps(payload))

    def test_partial_image_receipt_recovers_into_one_exact_policy(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            recovery = root / "recovery"
            recovery.mkdir()
            output = root / "output"
            args = fixture_args(output, recovery)
            image, image_upload = fixture_image(args)
            MODULE.write_receipt(
                recovery / "image.json",
                {
                    **MODULE.common_receipt(args, "2026-08-25T00:00:00Z"),
                    "containerImage": image,
                    "imageUpload": image_upload,
                },
            )
            created = SimpleNamespace(
                id="pvid_public_base_fixture",
                name=args.policy_name,
                version=1,
            )
            upload_client = FakeUploadClient()
            clients = [FakeReadClient(None), FakeReadClient(created)]
            with (
                patch.object(
                    MODULE.CoworldApiClient,
                    "from_login",
                    side_effect=clients,
                ),
                patch.object(
                    MODULE.CoworldUploadClient,
                    "from_login",
                    return_value=upload_client,
                ),
                patch.object(
                    MODULE.PolicyVersionResponse,
                    "model_validate",
                    return_value=SimpleNamespace(
                        id="pvid_public_base_fixture",
                        name=args.policy_name,
                        version=1,
                        pools=None,
                        submit_error=None,
                        model_dump=lambda **_: {
                            "id": "pvid_public_base_fixture",
                            "name": args.policy_name,
                            "version": 1,
                            "pools": None,
                            "submit_error": None,
                        },
                    ),
                ),
                redirect_stdout(StringIO()),
            ):
                MODULE.materialize(args)

            self.assertEqual(
                [path.name for path in sorted(output.iterdir())],
                ["image.json", "policy.json", "summary.json"],
            )
            self.assertEqual(len(upload_client._http_client.requests), 1)
            endpoint, payload = upload_client._http_client.requests[0]
            self.assertEqual(endpoint, "/stats/policies/docker-img/complete")
            self.assertEqual(payload["name"], args.policy_name)
            summary = MODULE.read_receipt(output / "summary.json")
            self.assertEqual(summary["policyCount"], 1)
            self.assertEqual(summary["bedrockEnvironmentCount"], 0)
            retained = json.dumps(summary, sort_keys=True).lower()
            self.assertNotIn("authorization", retained)
            self.assertNotIn("presigned", retained)
            self.assertNotIn("secret", retained)

    def test_name_only_remote_policy_is_never_adopted(self) -> None:
        policy_name = "proxywar-commander-public-base-" + "d" * 20
        existing = SimpleNamespace(id="pvid_unknown", name=policy_name, version=1)
        with patch.object(
            MODULE.CoworldApiClient,
            "from_login",
            return_value=FakeReadClient(existing),
        ):
            with self.assertRaisesRegex(RuntimeError, "already exists"):
                MODULE.assert_policy_absent(policy_name)

    def test_argument_contract_cross_checks_oci_digest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            args = fixture_args(Path(temporary) / "output")
            with patch.object(
                MODULE.importlib.metadata, "version", return_value="0.1.42"
            ):
                MODULE.validate_args(args)
                args.oci_digest = "sha256:" + "9" * 64
                with self.assertRaisesRegex(RuntimeError, "crossed"):
                    MODULE.validate_args(args)


if __name__ == "__main__":
    unittest.main()
