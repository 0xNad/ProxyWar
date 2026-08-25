#!/usr/bin/env python3
"""Focused identity and output-loss tests for public-base materialization."""

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


class PlaceholderUploadClient:
    @classmethod
    def from_login(cls, **_: object) -> object:
        raise AssertionError("unexpected unpatched Coworld upload client")


class PlaceholderReadClient:
    @classmethod
    def from_login(cls, **_: object) -> object:
        raise AssertionError("unexpected unpatched Coworld read client")


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


class ModelValue:
    def __init__(self, body: dict[str, object]) -> None:
        self.body = body
        for key, value in body.items():
            setattr(self, key, value)

    def model_dump(self, **_: object) -> dict[str, object]:
        return self.body


class FakeUploadClient:
    def __init__(
        self, rows: list[ModelValue], public_image: ModelValue | None = None
    ) -> None:
        self.rows = rows
        self.public_image = public_image
        self._http_client = SimpleNamespace(post=self.unexpected_post)

    def __enter__(self) -> "FakeUploadClient":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def list_images(self, *, limit: int, offset: int) -> list[ModelValue]:
        return self.rows[offset : offset + limit]

    def unexpected_post(self, *_: object, **__: object) -> object:
        raise AssertionError("remote adoption must not create or upload")

    def get_image(self, _image_id: str) -> ModelValue:
        if self.public_image is None:
            raise AssertionError("public image readback is missing")
        return self.public_image


class FakeReadClient:
    def __init__(self, policy: object | None) -> None:
        self.policy = policy

    def __enter__(self) -> "FakeReadClient":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def lookup_policy_version(self, **_: object) -> object | None:
        return self.policy


def fixture_args(
    output: Path,
    *,
    recovery: Path | None = None,
    allow_remote_adoption: bool = False,
) -> SimpleNamespace:
    digest = "sha256:" + "1" * 64
    args = SimpleNamespace(
        command="upload",
        image="ghcr.io/0xnad/proxywar-commander-public-base@" + digest,
        source_sha="2" * 40,
        source_tree_sha="3" * 40,
        source_provenance_digest="sha256:" + "4" * 64,
        build_provenance_digest="sha256:" + "5" * 64,
        oci_digest=digest,
        output=output,
        recovery=recovery,
        allow_remote_adoption=allow_remote_adoption,
    )
    args.policy_identity_sha256 = MODULE.sha256_bytes(
        MODULE.canonical_bytes(MODULE.policy_identity(args))
    )
    args.policy_name = (
        "proxywar-commander-public-base-v2-" + args.policy_identity_sha256
    )
    return args


def fixture_image(args: SimpleNamespace) -> dict[str, object]:
    expected = MODULE.expected_image_identity(args.image)
    digest = "sha256:" + "8" * 64
    return {
        "id": "img_public_base_fixture",
        "name": expected["name"],
        "version": 1,
        "client_hash": expected["client_hash"],
        "status": "ready",
        "image_uri": None,
        "image_digest": digest,
        "public_image_uri": "public.ecr.aws/example/cogames@" + digest,
    }


class PublicBaseMaterializeTest(unittest.TestCase):
    def test_runtime_is_exact_public_commander_without_eval_or_starter(self) -> None:
        self.assertEqual(
            MODULE.PUBLIC_COMMANDER_ARGV,
            [
                "node",
                "--import",
                "tsx",
                "/app/proxywar/coworld-adapter/src/commander-player.ts",
            ],
        )
        serialized = json.dumps(MODULE.PUBLIC_COMMANDER_ARGV).lower()
        self.assertNotIn("starter-player", serialized)
        self.assertNotIn("--arm", serialized)
        self.assertNotIn("commander-xp", serialized)

    def test_output_loss_adopts_exact_name_and_client_hash(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "output"
            args = fixture_args(output, allow_remote_adoption=True)
            image = fixture_image(args)
            current = SimpleNamespace(
                id="pvid_public_base_fixture",
                name=args.policy_name,
                version=1,
            )
            client = FakeUploadClient(
                [ModelValue(image)], public_image=ModelValue(image)
            )
            with (
                patch.object(
                    MODULE.CoworldUploadClient,
                    "from_login",
                    return_value=client,
                ),
                patch.object(
                    MODULE.CoworldApiClient,
                    "from_login",
                    return_value=FakeReadClient(current),
                ),
                redirect_stdout(StringIO()),
            ):
                MODULE.materialize(args)

            self.assertEqual(
                [path.name for path in sorted(output.iterdir())],
                ["image.json", "policy.json", "summary.json"],
            )
            summary = MODULE.read_receipt(output / "summary.json")
            self.assertEqual(
                summary["materializationMode"],
                "adopted-after-remote-success",
            )
            self.assertEqual(summary["imageCount"], 1)
            self.assertEqual(summary["policyCount"], 1)
            self.assertEqual(
                summary["policyCreationMode"],
                "adopted-after-remote-success",
            )
            self.assertEqual(summary["runtimeEntrypoint"], MODULE.PUBLIC_COMMANDER_ARGV)

    def test_remote_adoption_requires_recovery_authority(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "output"
            args = fixture_args(output)
            client = FakeUploadClient([ModelValue(fixture_image(args))])
            with patch.object(
                MODULE.CoworldUploadClient,
                "from_login",
                return_value=client,
            ):
                with self.assertRaisesRegex(RuntimeError, "recovery authority"):
                    MODULE.materialize(args)

    def test_discovery_rejects_name_or_hash_collision(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            args = fixture_args(Path(temporary) / "output")
            image = fixture_image(args)
            image["client_hash"] = "sha256:" + "9" * 64
            with self.assertRaisesRegex(RuntimeError, "collision"):
                MODULE.discover_exact_image(
                    FakeUploadClient([ModelValue(image)]), args
                )

    def test_policy_name_commits_exact_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            args = fixture_args(Path(temporary) / "output")
            with patch.object(
                MODULE.importlib.metadata, "version", return_value="0.1.42"
            ):
                MODULE.validate_args(args)
                args.source_provenance_digest = "sha256:" + "9" * 64
                with self.assertRaisesRegex(RuntimeError, "policy identity"):
                    MODULE.validate_args(args)

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
