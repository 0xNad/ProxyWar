#!/usr/bin/env python3
"""Upload one exact Commander XP image and six immutable policy versions.

The script is intentionally pinned to Coworld 0.1.42 by the protected caller.
It retains exact safe request/response projections and hashes the one presigned
response that cannot be published because it contains an ECR authorization
token. No credential or presigned value is written to the receipt bundle.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import re
import shutil
from datetime import UTC, datetime
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
COMMANDER_ARGV = [
    "node",
    "--import",
    "tsx",
    "/app/proxywar/coworld-adapter/src/commander-xp-player.ts",
]
OPPONENT_ARGV = [
    "node",
    "/app/proxywar/coworld-adapter/src/starter-player.mjs",
]
ROLES = ("A", "B", "C", "opponent-1", "opponent-2", "opponent-3")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
SOURCE_SHA = re.compile(r"^[0-9a-f]{40}$")
SAFE_NAME_PREFIX = re.compile(r"^[a-z0-9][a-z0-9-]{7,119}$")
BEDROCK_MODEL_ID = "us.anthropic.claude-sonnet-4-6"


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


def policy_name(prefix: str, role: str) -> str:
    return f"{prefix}-{role.lower()}"


def role_argv(role: str) -> list[str]:
    if role in {"A", "B", "C"}:
        return [*COMMANDER_ARGV, f"--arm={role}"]
    return list(OPPONENT_ARGV)


def validate_args(args: argparse.Namespace) -> None:
    if importlib.metadata.version("coworld") != "0.1.42":
        raise RuntimeError("Commander XP policy provision requires coworld==0.1.42")
    if not SAFE_NAME_PREFIX.fullmatch(args.name_prefix):
        raise RuntimeError("Commander XP policy name prefix is invalid")
    if not SOURCE_SHA.fullmatch(args.source_sha) or not SOURCE_SHA.fullmatch(
        args.source_tree_sha
    ):
        raise RuntimeError("Commander XP policy source identity is invalid")
    for value in (
        args.oci_digest,
        args.source_provenance_digest,
        args.build_provenance_digest,
    ):
        if not SHA256.fullmatch(value):
            raise RuntimeError("Commander XP policy digest is invalid")
    if not re.fullmatch(r"ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}", args.image):
        raise RuntimeError("Commander XP policy image must be an exact GHCR digest")
    if args.bedrock_model != BEDROCK_MODEL_ID:
        raise RuntimeError("Commander XP Bedrock model ID is not exact")
    if args.command == "upload":
        output = args.output.resolve()
        if output.exists() or not output.parent.is_dir():
            raise RuntimeError("Commander XP policy output must be a new directory")


def assert_names_absent(prefix: str) -> None:
    with CoworldApiClient.from_login(server_url=SERVER) as client:
        for role in ROLES:
            name = policy_name(prefix, role)
            if client.lookup_policy_version(name=name) is not None:
                raise RuntimeError(f"Commander XP policy already exists: {name}")


def assert_name_absent(name: str) -> None:
    with CoworldApiClient.from_login(server_url=SERVER) as client:
        if client.lookup_policy_version(name=name) is not None:
            raise RuntimeError(
                f"Commander XP policy exists without an adoptable receipt: {name}"
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
        completed_response = client._http_client.post(
            "/v2/container_images/upload/complete",
            headers=client._headers(),
            json=complete_payload,
            timeout=120.0,
        )
        completed_bytes, completed_json = exact_json_response(completed_response)
        completed = ContainerImageResponse.model_validate(completed_json)
    else:
        complete_payload = None
        completed_bytes = canonical_bytes(requested.image.model_dump(mode="json"))
        completed = requested.image
    if completed.status != "ready":
        raise RuntimeError(
            f"Commander XP policy image is not ready: {completed.status}"
        )
    if completed.image_digest is None or not SHA256.fullmatch(completed.image_digest):
        raise RuntimeError("Commander XP policy image digest is missing")
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
        "completeResponseSha256": sha256_bytes(completed_bytes),
        "completeResponseBytes": len(completed_bytes),
        "image": safe_image(completed),
    }


def create_policy(
    client: CoworldUploadClient,
    *,
    prefix: str,
    role: str,
    image_id: str,
    bedrock_model: str,
) -> dict[str, Any]:
    name = policy_name(prefix, role)
    commander = role in {"A", "B", "C"}
    environment_values = (
        {
            "AWS_REGION": "us-west-2",
            "BEDROCK_MODEL": bedrock_model,
            "USE_BEDROCK": "true",
        }
        if commander
        else {}
    )
    secret_env_id: str | None = None
    secret_response_sha256: str | None = None
    if commander:
        secret_payload = {"policy_secret_env": environment_values}
        secret_response = client._http_client.post(
            "/stats/policy-secret-envs",
            headers=client._headers(),
            json=secret_payload,
            timeout=120.0,
        )
        secret_bytes, secret_json = exact_json_response(secret_response)
        secret_env_id = secret_json.get("id")
        if not isinstance(secret_env_id, str) or not secret_env_id:
            raise RuntimeError("Commander XP policy secret environment ID is missing")
        secret_response_sha256 = sha256_bytes(secret_bytes)
    payload: dict[str, Any] = {
        "name": name,
        "container_image_id": image_id,
        "run": role_argv(role),
        "tags": {
            "purpose": "commander-xp-v2",
            "role": role,
        },
    }
    if secret_env_id is not None:
        payload["policy_secret_env_id"] = secret_env_id
    completion_projection = {
        "name": name,
        "container_image_id": image_id,
        "run": role_argv(role),
        "tags": payload["tags"],
        "environmentAttached": secret_env_id is not None,
    }
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
            f"Commander XP policy submission failed: {completed.submit_error}"
        )
    with CoworldApiClient.from_login(server_url=SERVER) as read_client:
        readback = read_client.lookup_policy_version(
            name=name, version=completed.version
        )
    if readback is None or str(readback.id) != completed.id or readback.name != name:
        raise RuntimeError("Commander XP policy readback mismatch")
    readback_projection = {
        "id": str(readback.id),
        "name": readback.name,
        "version": readback.version,
    }
    return {
        "name": name,
        "role": role,
        "runArgv": role_argv(role),
        "useBedrock": commander,
        "bedrockModel": bedrock_model if commander else None,
        "environmentConfiguration": {
            "attached": secret_env_id is not None,
            "keys": ["providerRegion", "modelID", "providerEnabled"]
            if commander
            else [],
            "valuesSha256": sha256_bytes(canonical_bytes(environment_values)),
            "attachmentResponseSha256": secret_response_sha256,
        },
        "completionPayloadProjection": completion_projection,
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
        raise RuntimeError(f"Commander XP receipt is invalid: {path.name}")
    digest = value.pop("receiptSha256", None)
    if digest != sha256_bytes(canonical_bytes(value)):
        raise RuntimeError(f"Commander XP receipt hash mismatch: {path.name}")
    return {**value, "receiptSha256": digest}


def exact_keys(value: dict[str, Any], keys: set[str], label: str) -> None:
    if set(value) != keys:
        raise RuntimeError(f"Commander XP {label} schema mismatch")


def validate_recovered_image(
    receipt: dict[str, Any], args: argparse.Namespace
) -> dict[str, Any]:
    exact_keys(
        receipt,
        {
            "schemaVersion",
            "authority",
            "inspectedAt",
            "platform",
            "sourceSha",
            "sourceTreeSha",
            "sourceProvenanceDigest",
            "buildProvenanceDigest",
            "ociImage",
            "ociDigest",
            "containerImage",
            "imageUpload",
            "receiptSha256",
        },
        "recovered image receipt",
    )
    if (
        receipt["schemaVersion"] != 2
        or receipt["authority"] != "coworld-0.1.42-policy-image-upload-v2"
        or receipt["platform"] != PLATFORM
        or receipt["sourceSha"] != args.source_sha
        or receipt["sourceTreeSha"] != args.source_tree_sha
        or receipt["sourceProvenanceDigest"] != args.source_provenance_digest
        or receipt["buildProvenanceDigest"] != args.build_provenance_digest
        or receipt["ociImage"] != args.image.split("@", 1)[0]
        or receipt["ociDigest"] != args.oci_digest
        or receipt["containerImage"].get("image_digest") != args.oci_digest
    ):
        raise RuntimeError("Commander XP recovered image identity mismatch")
    return receipt["containerImage"]


def validate_recovered_policy(
    receipt: dict[str, Any], args: argparse.Namespace, role: str, image: dict[str, Any]
) -> None:
    exact_keys(
        receipt,
        {
            "schemaVersion",
            "authority",
            "inspectedAt",
            "platform",
            "sourceSha",
            "sourceTreeSha",
            "sourceProvenanceDigest",
            "buildProvenanceDigest",
            "ociImage",
            "ociDigest",
            "containerImage",
            "imageUpload",
            "policy",
            "receiptSha256",
        },
        f"recovered policy receipt {role}",
    )
    policy = receipt["policy"]
    completed = policy.get("completionResponse")
    readback = policy.get("readback")
    expected_name = policy_name(args.name_prefix, role)
    if (
        receipt["schemaVersion"] != 2
        or receipt["authority"] != "coworld-0.1.42-policy-upload-readback-v2"
        or receipt["platform"] != PLATFORM
        or receipt["sourceSha"] != args.source_sha
        or receipt["sourceTreeSha"] != args.source_tree_sha
        or receipt["sourceProvenanceDigest"] != args.source_provenance_digest
        or receipt["buildProvenanceDigest"] != args.build_provenance_digest
        or receipt["ociImage"] != args.image.split("@", 1)[0]
        or receipt["ociDigest"] != args.oci_digest
        or receipt["containerImage"] != image
        or policy.get("name") != expected_name
        or policy.get("role") != role
        or policy.get("runArgv") != role_argv(role)
        or not isinstance(completed, dict)
        or not isinstance(readback, dict)
        or completed.get("id") != readback.get("id")
        or completed.get("name") != expected_name
        or readback.get("name") != expected_name
        or completed.get("version") != readback.get("version")
    ):
        raise RuntimeError(f"Commander XP recovered policy identity mismatch: {role}")
    with CoworldApiClient.from_login(server_url=SERVER) as read_client:
        current = read_client.lookup_policy_version(
            name=expected_name, version=readback["version"]
        )
    if (
        current is None
        or str(current.id) != readback["id"]
        or current.name != expected_name
        or current.version != readback["version"]
    ):
        raise RuntimeError(f"Commander XP recovered policy readback mismatch: {role}")


def upload(args: argparse.Namespace) -> None:
    args.output.mkdir(mode=0o700)
    inspected_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    recovered = args.recovery
    image_path = args.output / "image.json"
    if recovered is not None:
        recovered_image_path = recovered / "image.json"
        if not recovered_image_path.is_file():
            raise RuntimeError("Commander XP recovery is missing its image receipt")
        image_receipt = read_receipt(recovered_image_path)
        image = validate_recovered_image(image_receipt, args)
        shutil.copyfile(recovered_image_path, image_path)
        image_upload = image_receipt["imageUpload"]
        inspected_at = image_receipt["inspectedAt"]
    else:
        with CoworldUploadClient.from_login(server_url=SERVER) as client:
            image_upload = upload_image(client, args.image)
        image = image_upload["image"]
        if image["image_digest"] != args.oci_digest:
            raise RuntimeError(
                "Commander XP uploaded image digest does not match the attested OCI digest"
            )
        write_receipt(
            image_path,
            {
                "schemaVersion": 2,
                "authority": "coworld-0.1.42-policy-image-upload-v2",
                "inspectedAt": inspected_at,
                "platform": PLATFORM,
                "sourceSha": args.source_sha,
                "sourceTreeSha": args.source_tree_sha,
                "sourceProvenanceDigest": args.source_provenance_digest,
                "buildProvenanceDigest": args.build_provenance_digest,
                "ociImage": args.image.split("@", 1)[0],
                "ociDigest": args.oci_digest,
                "containerImage": image,
                "imageUpload": image_upload,
            },
        )
    common = {
        "schemaVersion": 2,
        "authority": "coworld-0.1.42-policy-upload-readback-v2",
        "inspectedAt": inspected_at,
        "platform": PLATFORM,
        "sourceSha": args.source_sha,
        "sourceTreeSha": args.source_tree_sha,
        "sourceProvenanceDigest": args.source_provenance_digest,
        "buildProvenanceDigest": args.build_provenance_digest,
        "ociImage": args.image.split("@", 1)[0],
        "ociDigest": args.oci_digest,
        "containerImage": image,
        "imageUpload": image_upload,
    }
    receipts: dict[str, dict[str, Any]] = {}
    for role in ROLES:
        receipt_path = args.output / f"{role}.json"
        recovered_path = None if recovered is None else recovered / f"{role}.json"
        if recovered_path is not None and recovered_path.is_file():
            receipt = read_receipt(recovered_path)
            validate_recovered_policy(receipt, args, role, image)
            shutil.copyfile(recovered_path, receipt_path)
            receipts[role] = receipt
        else:
            assert_name_absent(policy_name(args.name_prefix, role))
            with CoworldUploadClient.from_login(server_url=SERVER) as client:
                policy = create_policy(
                    client,
                    prefix=args.name_prefix,
                    role=role,
                    image_id=image["id"],
                    bedrock_model=args.bedrock_model,
                )
            receipts[role] = write_receipt(
                receipt_path, {**common, "policy": policy}
            )
    arm_identities = {
        role: {
            "policyVersionID": receipts[role]["policy"]["completionResponse"]["id"],
            "imageDigest": args.oci_digest,
            "useBedrock": True,
            "bedrockModel": args.bedrock_model,
            "runArgv": receipts[role]["policy"]["runArgv"],
            "inspectResponseSha256": sha256_bytes(
                (args.output / f"{role}.json").read_bytes()
            ),
        }
        for role in ("A", "B", "C")
    }
    summary_body = {
        "schemaVersion": 2,
        "authority": "coworld-0.1.42-policy-provision-v2",
        "inspectedAt": inspected_at,
        "platform": PLATFORM,
        "sourceSha": args.source_sha,
        "sourceTreeSha": args.source_tree_sha,
        "sourceProvenanceDigest": args.source_provenance_digest,
        "policyBuildProvenanceDigest": args.build_provenance_digest,
        "ociImage": args.image.split("@", 1)[0],
        "ociDigest": args.oci_digest,
        "policyImageID": image["id"],
        "imageDigest": args.oci_digest,
        "bedrockModel": args.bedrock_model,
        "arms": arm_identities,
        "opponentPolicyVersionIDs": [
            receipts[f"opponent-{index}"]["policy"]["completionResponse"]["id"]
            for index in (1, 2, 3)
        ],
    }
    write_receipt(args.output / "policy-identities-v2.json", summary_body)
    print(
        json.dumps(
            {
                "ok": True,
                "imageID": image["id"],
                "imageDigest": image["image_digest"],
                "policyCount": 6,
                "adoptedPolicyCount": sum(
                    1
                    for role in ROLES
                    if recovered is not None and (recovered / f"{role}.json").is_file()
                ),
            }
        )
    )


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("command", choices=("check", "upload"))
    result.add_argument("--image", required=True)
    result.add_argument("--name-prefix", required=True)
    result.add_argument("--bedrock-model", required=True)
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
        assert_names_absent(args.name_prefix)
        print(json.dumps({"ok": True, "namesAvailable": 6}))
        return
    if args.output is None or not args.output.is_absolute():
        raise RuntimeError(
            "Commander XP policy upload requires an absolute output directory"
        )
    if args.recovery is not None:
        recovery = args.recovery.resolve()
        if recovery == args.output.resolve() or not recovery.is_dir():
            raise RuntimeError("Commander XP policy recovery directory is invalid")
        args.recovery = recovery
    upload(args)


if __name__ == "__main__":
    main()
