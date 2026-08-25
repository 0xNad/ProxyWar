#!/usr/bin/env python3
"""Materialize one exact Commander public-base image through Coworld.

The protected workflow pins this helper to Coworld 0.1.42. It creates exactly
one non-Bedrock policy whose only purpose is to make Coworld retain and expose
the immutable public image. Presigned credentials and authorization values are
never written to retained receipts.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from coworld.api_client import CoworldApiClient
from coworld.upload import (
    ContainerImageResponse,
    CoworldUploadClient,
    ImageUploadResponse,
    PolicyVersionResponse,
    _image_upload_name,
    _local_image_client_hash,
    _push_container_image,
)

SERVER = "https://softmax.com/api"
PLATFORM = "linux/amd64"
COWORLD_VERSION = "0.1.42"
POLICY_ARGV = [
    "node",
    "/app/proxywar/coworld-adapter/src/starter-player.mjs",
]
POLICY_PURPOSE = "commander-public-base-materialization-v1"
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
SOURCE_SHA = re.compile(r"^[0-9a-f]{40}$")
POLICY_NAME = re.compile(r"^proxywar-commander-public-base-[0-9a-f]{20}$")
GHCR_IMAGE = re.compile(
    r"^ghcr\.io/0xnad/proxywar-commander-public-base@sha256:[0-9a-f]{64}$"
)


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def exact_json_response(response: Any) -> tuple[bytes, Any]:
    body = response.content
    response.raise_for_status()
    return body, response.json()


def safe_image(image: ContainerImageResponse) -> dict[str, Any]:
    return image.model_dump(mode="json")


def validate_args(args: argparse.Namespace) -> None:
    if importlib.metadata.version("coworld") != COWORLD_VERSION:
        raise RuntimeError(
            f"Commander public base requires coworld=={COWORLD_VERSION}"
        )
    if not GHCR_IMAGE.fullmatch(args.image):
        raise RuntimeError("Commander public base image is not an exact GHCR digest")
    if not POLICY_NAME.fullmatch(args.policy_name):
        raise RuntimeError("Commander public base policy name is invalid")
    if not SOURCE_SHA.fullmatch(args.source_sha) or not SOURCE_SHA.fullmatch(
        args.source_tree_sha
    ):
        raise RuntimeError("Commander public base source identity is invalid")
    for value in (
        args.oci_digest,
        args.source_provenance_digest,
        args.build_provenance_digest,
    ):
        if not SHA256.fullmatch(value):
            raise RuntimeError("Commander public base digest is invalid")
    if args.image.rsplit("@", 1)[1] != args.oci_digest:
        raise RuntimeError("Commander public base image digest is crossed")
    if args.command == "upload":
        if args.output is None or not args.output.is_absolute():
            raise RuntimeError(
                "Commander public base upload requires an absolute output directory"
            )
        output = args.output.resolve()
        if output.exists() or not output.parent.is_dir():
            raise RuntimeError(
                "Commander public base output must be a new directory"
            )
        if args.recovery is not None:
            recovery = args.recovery.resolve()
            if recovery == output or not recovery.is_dir():
                raise RuntimeError(
                    "Commander public base recovery directory is invalid"
                )
            args.recovery = recovery


def assert_policy_absent(policy_name: str) -> None:
    with CoworldApiClient.from_login(server_url=SERVER) as client:
        if client.lookup_policy_version(name=policy_name) is not None:
            raise RuntimeError(
                f"Commander public base policy already exists: {policy_name}"
            )


def upload_image(client: CoworldUploadClient, image: str) -> dict[str, Any]:
    request_payload = {
        "name": _image_upload_name(image),
        "client_hash": _local_image_client_hash(image),
    }
    response = client._http_client.post(
        "/v2/container_images/upload",
        headers=client._headers(),
        json=request_payload,
        timeout=60.0,
    )
    response_bytes, response_json = exact_json_response(response)
    requested = ImageUploadResponse.model_validate(response_json)
    if requested.pre_signed_info is not None:
        _push_container_image(image, requested.pre_signed_info)
        complete_payload = {"id": requested.image.id}
        complete_response = client._http_client.post(
            "/v2/container_images/upload/complete",
            headers=client._headers(),
            json=complete_payload,
            timeout=120.0,
        )
        complete_bytes, complete_json = exact_json_response(complete_response)
        completed = ContainerImageResponse.model_validate(complete_json)
    else:
        complete_payload = None
        complete_bytes = canonical_bytes(requested.image.model_dump(mode="json"))
        completed = requested.image
    if completed.status != "ready":
        raise RuntimeError(
            f"Commander public base image is not ready: {completed.status}"
        )
    if completed.image_digest is None or not SHA256.fullmatch(
        completed.image_digest
    ):
        raise RuntimeError("Commander public base Coworld image digest is missing")
    return {
        "requestPayload": request_payload,
        "requestPayloadSha256": sha256_bytes(canonical_bytes(request_payload)),
        "responseSha256": sha256_bytes(response_bytes),
        "responseBytes": len(response_bytes),
        "responseProjection": {
            "image": safe_image(requested.image),
            "uploadRequired": requested.pre_signed_info is not None,
        },
        "completePayload": complete_payload,
        "completePayloadSha256": None
        if complete_payload is None
        else sha256_bytes(canonical_bytes(complete_payload)),
        "completeResponseSha256": sha256_bytes(complete_bytes),
        "completeResponseBytes": len(complete_bytes),
        "image": safe_image(completed),
    }


def policy_payload(
    *, policy_name: str, image_id: str, source_sha: str, source_tree_sha: str
) -> dict[str, Any]:
    return {
        "name": policy_name,
        "container_image_id": image_id,
        "run": POLICY_ARGV,
        "tags": {
            "purpose": POLICY_PURPOSE,
            "source-sha": source_sha,
            "source-tree-sha": source_tree_sha,
        },
    }


def create_policy(
    client: CoworldUploadClient,
    *,
    policy_name: str,
    image_id: str,
    source_sha: str,
    source_tree_sha: str,
) -> dict[str, Any]:
    payload = policy_payload(
        policy_name=policy_name,
        image_id=image_id,
        source_sha=source_sha,
        source_tree_sha=source_tree_sha,
    )
    response = client._http_client.post(
        "/stats/policies/docker-img/complete",
        headers=client._headers(),
        json=payload,
        timeout=120.0,
    )
    response_bytes, response_json = exact_json_response(response)
    completed = PolicyVersionResponse.model_validate(response_json)
    if completed.submit_error is not None:
        raise RuntimeError(
            f"Commander public base policy submission failed: {completed.submit_error}"
        )
    with CoworldApiClient.from_login(server_url=SERVER) as read_client:
        readback = read_client.lookup_policy_version(
            name=policy_name, version=completed.version
        )
    if (
        readback is None
        or str(readback.id) != completed.id
        or readback.name != policy_name
        or readback.version != completed.version
    ):
        raise RuntimeError("Commander public base policy readback mismatch")
    readback_projection = {
        "id": str(readback.id),
        "name": readback.name,
        "version": readback.version,
    }
    return {
        "name": policy_name,
        "runArgv": POLICY_ARGV,
        "useBedrock": False,
        "purpose": POLICY_PURPOSE,
        "creationMode": "immediate-response",
        "completionPayload": payload,
        "completionPayloadSha256": sha256_bytes(canonical_bytes(payload)),
        "completionResponse": completed.model_dump(mode="json"),
        "completionResponseSha256": sha256_bytes(response_bytes),
        "completionResponseBytes": len(response_bytes),
        "readback": readback_projection,
        "readbackSha256": sha256_bytes(canonical_bytes(readback_projection)),
    }


def write_receipt(path: Path, body: dict[str, Any]) -> dict[str, Any]:
    receipt = {**body, "receiptSha256": sha256_bytes(canonical_bytes(body))}
    path.write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return receipt


def read_receipt(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"Commander public base receipt is invalid: {path.name}")
    digest = value.pop("receiptSha256", None)
    if digest != sha256_bytes(canonical_bytes(value)):
        raise RuntimeError(
            f"Commander public base receipt hash mismatch: {path.name}"
        )
    return {**value, "receiptSha256": digest}


def common_receipt(args: argparse.Namespace, inspected_at: str) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "authority": "coworld-0.1.42-commander-public-base-v1",
        "inspectedAt": inspected_at,
        "platform": PLATFORM,
        "sourceSha": args.source_sha,
        "sourceTreeSha": args.source_tree_sha,
        "behaviorSourceSha": args.source_sha,
        "behaviorSourceTreeSha": args.source_tree_sha,
        "adapterSourceSha": args.source_sha,
        "adapterSourceTreeSha": args.source_tree_sha,
        "sourceProvenanceDigest": args.source_provenance_digest,
        "buildProvenanceDigest": args.build_provenance_digest,
        "ociImage": args.image.split("@", 1)[0],
        "ociDigest": args.oci_digest,
        "policyName": args.policy_name,
    }


def validate_image_binding(
    image_upload: dict[str, Any], image: dict[str, Any], args: argparse.Namespace
) -> None:
    request_payload = image_upload.get("requestPayload")
    client_hash = (
        None
        if not isinstance(request_payload, dict)
        else request_payload.get("client_hash")
    )
    image_digest = image.get("image_digest")
    if (
        not isinstance(request_payload, dict)
        or set(request_payload) != {"name", "client_hash"}
        or request_payload.get("name") != _image_upload_name(args.image)
        or not isinstance(client_hash, str)
        or not SHA256.fullmatch(client_hash)
        or image.get("client_hash") != client_hash
        or image.get("status") != "ready"
        or not isinstance(image_digest, str)
        or not SHA256.fullmatch(image_digest)
        or image_upload.get("image") != image
        or image_upload.get("requestPayloadSha256")
        != sha256_bytes(canonical_bytes(request_payload))
    ):
        raise RuntimeError("Commander public base Coworld image binding mismatch")


def validate_common(
    receipt: dict[str, Any], args: argparse.Namespace, inspected_at: str | None = None
) -> None:
    expected = common_receipt(
        args,
        receipt.get("inspectedAt") if inspected_at is None else inspected_at,
    )
    for key, value in expected.items():
        if receipt.get(key) != value:
            raise RuntimeError(
                f"Commander public base recovered identity mismatch: {key}"
            )


def validate_recovered_image(
    receipt: dict[str, Any], args: argparse.Namespace
) -> dict[str, Any]:
    validate_common(receipt, args)
    image = receipt.get("containerImage")
    image_upload = receipt.get("imageUpload")
    if not isinstance(image, dict) or not isinstance(image_upload, dict):
        raise RuntimeError("Commander public base recovered image is invalid")
    validate_image_binding(image_upload, image, args)
    return image


def validate_recovered_policy(
    receipt: dict[str, Any], args: argparse.Namespace, image: dict[str, Any]
) -> dict[str, Any]:
    validate_common(receipt, args)
    if receipt.get("containerImage") != image:
        raise RuntimeError("Commander public base recovered policy image mismatch")
    policy = receipt.get("policy")
    if not isinstance(policy, dict):
        raise RuntimeError("Commander public base recovered policy is invalid")
    expected_payload = policy_payload(
        policy_name=args.policy_name,
        image_id=image["id"],
        source_sha=args.source_sha,
        source_tree_sha=args.source_tree_sha,
    )
    completed = policy.get("completionResponse")
    readback = policy.get("readback")
    if (
        policy.get("name") != args.policy_name
        or policy.get("runArgv") != POLICY_ARGV
        or policy.get("useBedrock") is not False
        or policy.get("purpose") != POLICY_PURPOSE
        or policy.get("creationMode") != "immediate-response"
        or policy.get("completionPayload") != expected_payload
        or policy.get("completionPayloadSha256")
        != sha256_bytes(canonical_bytes(expected_payload))
        or not isinstance(completed, dict)
        or not isinstance(readback, dict)
        or completed.get("id") != readback.get("id")
        or completed.get("name") != args.policy_name
        or readback.get("name") != args.policy_name
        or completed.get("version") != readback.get("version")
    ):
        raise RuntimeError("Commander public base recovered policy mismatch")
    with CoworldApiClient.from_login(server_url=SERVER) as read_client:
        current = read_client.lookup_policy_version(
            name=args.policy_name, version=readback["version"]
        )
    if (
        current is None
        or str(current.id) != readback["id"]
        or current.name != args.policy_name
        or current.version != readback["version"]
    ):
        raise RuntimeError("Commander public base recovered policy readback mismatch")
    return policy


def materialize(args: argparse.Namespace) -> None:
    args.output.mkdir(mode=0o700)
    inspected_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    image_path = args.output / "image.json"
    policy_path = args.output / "policy.json"
    summary_path = args.output / "summary.json"

    recovered_image = None if args.recovery is None else args.recovery / "image.json"
    if recovered_image is not None and recovered_image.is_file():
        image_receipt = read_receipt(recovered_image)
        image = validate_recovered_image(image_receipt, args)
        inspected_at = image_receipt["inspectedAt"]
        shutil.copyfile(recovered_image, image_path)
        image_upload = image_receipt["imageUpload"]
    else:
        with CoworldUploadClient.from_login(server_url=SERVER) as client:
            image_upload = upload_image(client, args.image)
        image = image_upload["image"]
        validate_image_binding(image_upload, image, args)
        write_receipt(
            image_path,
            {
                **common_receipt(args, inspected_at),
                "containerImage": image,
                "imageUpload": image_upload,
            },
        )

    recovered_policy = (
        None if args.recovery is None else args.recovery / "policy.json"
    )
    if recovered_policy is not None and recovered_policy.is_file():
        policy_receipt = read_receipt(recovered_policy)
        policy = validate_recovered_policy(policy_receipt, args, image)
        shutil.copyfile(recovered_policy, policy_path)
    else:
        # Never infer policy/image binding from a name-only remote row. If a
        # policy exists without its exact retained receipt, recovery must stop.
        assert_policy_absent(args.policy_name)
        with CoworldUploadClient.from_login(server_url=SERVER) as client:
            policy = create_policy(
                client,
                policy_name=args.policy_name,
                image_id=image["id"],
                source_sha=args.source_sha,
                source_tree_sha=args.source_tree_sha,
            )
        write_receipt(
            policy_path,
            {
                **common_receipt(args, inspected_at),
                "containerImage": image,
                "policy": policy,
            },
        )

    summary = write_receipt(
        summary_path,
        {
            **common_receipt(args, inspected_at),
            "containerImage": image,
            "policyVersion": policy["readback"],
            "policyCount": 1,
            "bedrockEnvironmentCount": 0,
        },
    )
    print(
        json.dumps(
            {
                "ok": True,
                "policyCount": 1,
                "policyVersionID": policy["readback"]["id"],
                "coworldImageID": image["id"],
                "coworldImageDigest": image["image_digest"],
                "publicImageURI": image.get("public_image_uri"),
                "summaryReceiptSha256": summary["receiptSha256"],
            }
        )
    )


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("command", choices=("check", "upload"))
    result.add_argument("--image", required=True)
    result.add_argument("--policy-name", required=True)
    result.add_argument("--source-sha", required=True)
    result.add_argument("--source-tree-sha", required=True)
    result.add_argument("--source-provenance-digest", required=True)
    result.add_argument("--build-provenance-digest", required=True)
    result.add_argument("--oci-digest", required=True)
    result.add_argument("--output", type=Path)
    result.add_argument("--recovery", type=Path)
    return result


def main() -> None:
    args = parser().parse_args()
    validate_args(args)
    if args.command == "check":
        assert_policy_absent(args.policy_name)
        print(json.dumps({"ok": True, "namesAvailable": 1}))
        return
    materialize(args)


if __name__ == "__main__":
    main()
