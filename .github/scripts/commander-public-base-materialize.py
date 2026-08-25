#!/usr/bin/env python3
"""Materialize one exact Commander public-base image through Coworld.

The protected workflow pins this helper to Coworld 0.1.42. It creates one
exact-entrypoint materialization policy and no environment, league entry, or
evaluation package. Exact Coworld image name/client-hash discovery and a
provenance-committed policy name make completed work adoptable after local
output loss without accepting an ambiguous name-only row.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import re
import shutil
import time
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
PUBLIC_COMMANDER_ARGV = [
    "node",
    "--import",
    "tsx",
    "/app/proxywar/coworld-adapter/src/commander-player.ts",
]
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
SOURCE_SHA = re.compile(r"^[0-9a-f]{40}$")
GHCR_IMAGE = re.compile(
    r"^ghcr\.io/0xnad/proxywar-commander-public-base@sha256:[0-9a-f]{64}$"
)
PUBLIC_IMAGE = re.compile(r"^public\.ecr\.aws/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$")
IMAGE_PAGE_SIZE = 200
IMAGE_PAGE_LIMIT = 8
POLICY_NAME = re.compile(r"^proxywar-commander-public-base-v2-[0-9a-f]{64}$")
POLICY_PURPOSE = "commander-public-base-materialization-v2"
PUBLIC_IMAGE_ATTEMPTS = 12
PUBLIC_IMAGE_INTERVAL_SECONDS = 5


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


def expected_image_identity(image: str) -> dict[str, str]:
    return {
        "name": _image_upload_name(image),
        "client_hash": _local_image_client_hash(image),
    }


def policy_identity(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "sourceSha": args.source_sha,
        "sourceTreeSha": args.source_tree_sha,
        "sourceProvenanceDigest": args.source_provenance_digest,
        "buildProvenanceDigest": args.build_provenance_digest,
        "ociImage": args.image.split("@", 1)[0],
        "ociDigest": args.oci_digest,
        "runtimeEntrypoint": PUBLIC_COMMANDER_ARGV,
        "purpose": POLICY_PURPOSE,
    }


def policy_payload(args: argparse.Namespace, image_id: str) -> dict[str, Any]:
    return {
        "name": args.policy_name,
        "container_image_id": image_id,
        "run": PUBLIC_COMMANDER_ARGV,
        "tags": {
            "purpose": POLICY_PURPOSE,
            "identity-sha256": args.policy_identity_sha256,
            "source-sha": args.source_sha,
            "source-tree-sha": args.source_tree_sha,
            "source-provenance": args.source_provenance_digest,
            "build-provenance": args.build_provenance_digest,
            "oci-digest": args.oci_digest,
        },
    }


def validate_args(args: argparse.Namespace) -> None:
    if importlib.metadata.version("coworld") != COWORLD_VERSION:
        raise RuntimeError(
            f"Commander public base requires coworld=={COWORLD_VERSION}"
        )
    if not GHCR_IMAGE.fullmatch(args.image):
        raise RuntimeError("Commander public base image is not an exact GHCR digest")
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
    expected_policy_identity = sha256_bytes(canonical_bytes(policy_identity(args)))
    if (
        not POLICY_NAME.fullmatch(args.policy_name)
        or not re.fullmatch(r"^[0-9a-f]{64}$", args.policy_identity_sha256)
        or args.policy_name.rsplit("-", 1)[1] != args.policy_identity_sha256
        or args.policy_identity_sha256 != expected_policy_identity
    ):
        raise RuntimeError("Commander public base policy identity is crossed")
    if args.command == "upload":
        if args.output is None or not args.output.is_absolute():
            raise RuntimeError(
                "Commander public base upload requires an absolute output directory"
            )
        output = args.output.resolve()
        if output.exists() or not output.parent.is_dir():
            raise RuntimeError("Commander public base output must be a new directory")
        if args.recovery is not None:
            recovery = args.recovery.resolve()
            if recovery == output or not recovery.is_dir():
                raise RuntimeError(
                    "Commander public base recovery directory is invalid"
                )
            args.recovery = recovery


def validate_image(
    image: dict[str, Any],
    args: argparse.Namespace,
    *,
    require_public: bool = False,
) -> None:
    expected = expected_image_identity(args.image)
    public_uri = image.get("public_image_uri")
    if (
        image.get("name") != expected["name"]
        or image.get("client_hash") != expected["client_hash"]
        or not isinstance(image.get("id"), str)
        or not image["id"]
        or not isinstance(image.get("version"), int)
        or image["version"] < 1
        or image.get("status") != "ready"
        or not isinstance(image.get("image_digest"), str)
        or not SHA256.fullmatch(image["image_digest"])
        or (
            public_uri is not None
            and (
                not isinstance(public_uri, str)
                or not PUBLIC_IMAGE.fullmatch(public_uri)
            )
        )
        or (require_public and public_uri is None)
    ):
        raise RuntimeError("Commander public base Coworld image identity mismatch")


def discover_exact_image(
    client: CoworldUploadClient, args: argparse.Namespace
) -> dict[str, Any] | None:
    expected = expected_image_identity(args.image)
    exact: list[dict[str, Any]] = []
    for page_index in range(IMAGE_PAGE_LIMIT):
        rows = client.list_images(
            limit=IMAGE_PAGE_SIZE, offset=page_index * IMAGE_PAGE_SIZE
        )
        for row in rows:
            image = safe_image(row)
            same_name = image.get("name") == expected["name"]
            same_hash = image.get("client_hash") == expected["client_hash"]
            if same_name != same_hash:
                raise RuntimeError(
                    "Commander public base Coworld image name/hash collision"
                )
            if same_name and same_hash:
                exact.append(image)
        if len(rows) < IMAGE_PAGE_SIZE:
            break
    else:
        raise RuntimeError("Commander public base Coworld image inventory is unbounded")
    if len(exact) > 1:
        raise RuntimeError("Commander public base Coworld image identity is ambiguous")
    if not exact:
        return None
    validate_image(exact[0], args)
    return exact[0]


def upload_image(client: CoworldUploadClient, args: argparse.Namespace) -> dict[str, Any]:
    request_payload = expected_image_identity(args.image)
    response = client._http_client.post(
        "/v2/container_images/upload",
        headers=client._headers(),
        json=request_payload,
        timeout=60.0,
    )
    response_bytes, response_json = exact_json_response(response)
    requested = ImageUploadResponse.model_validate(response_json)
    if requested.pre_signed_info is not None:
        _push_container_image(args.image, requested.pre_signed_info)
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
    image = safe_image(completed)
    validate_image(image, args)
    return {
        "mode": "uploaded" if requested.pre_signed_info is not None else "idempotent-upload-response",
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
        "image": image,
    }


def adopted_image(args: argparse.Namespace, image: dict[str, Any]) -> dict[str, Any]:
    request_payload = expected_image_identity(args.image)
    response_projection = {"image": image, "uploadRequired": False}
    response_bytes = canonical_bytes(response_projection)
    return {
        "mode": "adopted-after-remote-success",
        "requestPayload": request_payload,
        "requestPayloadSha256": sha256_bytes(canonical_bytes(request_payload)),
        "responseSha256": sha256_bytes(response_bytes),
        "responseBytes": len(response_bytes),
        "responseProjection": response_projection,
        "completePayload": None,
        "completePayloadSha256": None,
        "completeResponseSha256": sha256_bytes(canonical_bytes(image)),
        "completeResponseBytes": len(canonical_bytes(image)),
        "image": image,
    }


def policy_projection(
    args: argparse.Namespace,
    image_id: str,
    current: Any,
    mode: str,
    response_bytes: bytes,
) -> dict[str, Any]:
    payload = policy_payload(args, image_id)
    readback = {
        "id": str(current.id),
        "name": current.name,
        "version": current.version,
    }
    if (
        readback["name"] != args.policy_name
        or readback["version"] != 1
        or not readback["id"]
    ):
        raise RuntimeError("Commander public base policy readback mismatch")
    return {
        "name": args.policy_name,
        "policyIdentitySha256": args.policy_identity_sha256,
        "purpose": POLICY_PURPOSE,
        "runArgv": PUBLIC_COMMANDER_ARGV,
        "useBedrock": False,
        "creationMode": mode,
        "plannedCompletionPayload": payload,
        "plannedCompletionPayloadSha256": sha256_bytes(canonical_bytes(payload)),
        "completionResponseSha256": sha256_bytes(response_bytes),
        "completionResponseBytes": len(response_bytes),
        "readback": readback,
        "readbackSha256": sha256_bytes(canonical_bytes(readback)),
    }


def create_policy(
    client: CoworldUploadClient,
    args: argparse.Namespace,
    image_id: str,
) -> dict[str, Any]:
    payload = policy_payload(args, image_id)
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
        current = read_client.lookup_policy_version(
            name=args.policy_name, version=completed.version
        )
    if current is None or str(current.id) != completed.id:
        raise RuntimeError("Commander public base policy completion mismatch")
    return policy_projection(
        args, image_id, current, "immediate-response", response_bytes
    )


def discover_policy(args: argparse.Namespace, image_id: str) -> dict[str, Any] | None:
    with CoworldApiClient.from_login(server_url=SERVER) as read_client:
        current = read_client.lookup_policy_version(name=args.policy_name)
    if current is None:
        return None
    response_bytes = canonical_bytes(
        {"id": str(current.id), "name": current.name, "version": current.version}
    )
    return policy_projection(
        args,
        image_id,
        current,
        "adopted-after-remote-success",
        response_bytes,
    )


def refreshed_public_image(
    client: CoworldUploadClient,
    args: argparse.Namespace,
    image_id: str,
) -> dict[str, Any]:
    for attempt in range(PUBLIC_IMAGE_ATTEMPTS):
        image = safe_image(client.get_image(image_id))
        try:
            validate_image(image, args, require_public=True)
            return image
        except RuntimeError:
            if attempt + 1 == PUBLIC_IMAGE_ATTEMPTS:
                raise
            time.sleep(PUBLIC_IMAGE_INTERVAL_SECONDS)
    raise RuntimeError("Commander public base public image did not materialize")


def common_receipt(args: argparse.Namespace, inspected_at: str) -> dict[str, Any]:
    expected = expected_image_identity(args.image)
    return {
        "schemaVersion": 2,
        "authority": "coworld-0.1.42-commander-public-base-image-v2",
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
        "coworldImageName": expected["name"],
        "coworldClientHash": expected["client_hash"],
        "policyName": args.policy_name,
        "policyIdentitySha256": args.policy_identity_sha256,
        "runtimeEntrypoint": PUBLIC_COMMANDER_ARGV,
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


def validate_common(receipt: dict[str, Any], args: argparse.Namespace) -> None:
    expected = common_receipt(args, receipt.get("inspectedAt"))
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
    validate_image(image, args)
    if (
        image_upload.get("image") != image
        or image_upload.get("requestPayload") != expected_image_identity(args.image)
        or image_upload.get("requestPayloadSha256")
        != sha256_bytes(canonical_bytes(expected_image_identity(args.image)))
        or image_upload.get("mode")
        not in {
            "uploaded",
            "idempotent-upload-response",
            "adopted-after-remote-success",
        }
    ):
        raise RuntimeError("Commander public base recovered image binding mismatch")
    return image


def validate_recovered_policy(
    receipt: dict[str, Any],
    args: argparse.Namespace,
) -> tuple[dict[str, Any], dict[str, Any]]:
    validate_common(receipt, args)
    image = receipt.get("containerImage")
    policy = receipt.get("policy")
    if not isinstance(image, dict) or not isinstance(policy, dict):
        raise RuntimeError("Commander public base recovered policy is invalid")
    validate_image(image, args, require_public=True)
    payload = policy_payload(args, image["id"])
    readback = policy.get("readback")
    if (
        policy.get("name") != args.policy_name
        or policy.get("policyIdentitySha256") != args.policy_identity_sha256
        or policy.get("purpose") != POLICY_PURPOSE
        or policy.get("runArgv") != PUBLIC_COMMANDER_ARGV
        or policy.get("useBedrock") is not False
        or policy.get("creationMode")
        not in {"immediate-response", "adopted-after-remote-success"}
        or policy.get("plannedCompletionPayload") != payload
        or policy.get("plannedCompletionPayloadSha256")
        != sha256_bytes(canonical_bytes(payload))
        or not isinstance(readback, dict)
        or readback.get("name") != args.policy_name
        or readback.get("version") != 1
    ):
        raise RuntimeError("Commander public base recovered policy binding mismatch")
    with CoworldApiClient.from_login(server_url=SERVER) as read_client:
        current = read_client.lookup_policy_version(
            name=args.policy_name, version=readback["version"]
        )
    if current is None or str(current.id) != readback.get("id"):
        raise RuntimeError("Commander public base recovered policy readback mismatch")
    return image, policy


def materialize(args: argparse.Namespace) -> None:
    args.output.mkdir(mode=0o700)
    inspected_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    image_path = args.output / "image.json"
    policy_path = args.output / "policy.json"
    summary_path = args.output / "summary.json"

    recovered_path = None if args.recovery is None else args.recovery / "image.json"
    if recovered_path is not None and recovered_path.is_file():
        image_receipt = read_receipt(recovered_path)
        image = validate_recovered_image(image_receipt, args)
        inspected_at = image_receipt["inspectedAt"]
        shutil.copyfile(recovered_path, image_path)
        image_upload = image_receipt["imageUpload"]
    else:
        with CoworldUploadClient.from_login(server_url=SERVER) as client:
            existing = discover_exact_image(client, args)
            if existing is not None:
                if not args.allow_remote_adoption:
                    raise RuntimeError(
                        "Commander public base image exists without recovery authority"
                    )
                image_upload = adopted_image(args, existing)
            else:
                image_upload = upload_image(client, args)
        image = image_upload["image"]
        write_receipt(
            image_path,
            {
                **common_receipt(args, inspected_at),
                "containerImage": image,
                "imageUpload": image_upload,
            },
        )

    recovered_policy_path = (
        None if args.recovery is None else args.recovery / "policy.json"
    )
    if recovered_policy_path is not None and recovered_policy_path.is_file():
        policy_receipt = read_receipt(recovered_policy_path)
        public_image, policy = validate_recovered_policy(policy_receipt, args)
        shutil.copyfile(recovered_policy_path, policy_path)
    else:
        policy = discover_policy(args, image["id"])
        if policy is not None and not args.allow_remote_adoption:
            raise RuntimeError(
                "Commander public base policy exists without recovery authority"
            )
        with CoworldUploadClient.from_login(server_url=SERVER) as client:
            if policy is None:
                policy = create_policy(client, args, image["id"])
            public_image = refreshed_public_image(client, args, image["id"])
        write_receipt(
            policy_path,
            {
                **common_receipt(args, inspected_at),
                "containerImage": public_image,
                "policy": policy,
            },
        )

    summary = write_receipt(
        summary_path,
        {
            **common_receipt(args, inspected_at),
            "containerImage": public_image,
            "materializationMode": image_upload["mode"],
            "policyCreationMode": policy["creationMode"],
            "policyVersion": policy["readback"],
            "imageCount": 1,
            "policyCount": 1,
            "bedrockEnvironmentCount": 0,
        },
    )
    print(
        json.dumps(
            {
                "ok": True,
                "imageCount": 1,
                "policyCount": 1,
                "policyVersionID": policy["readback"]["id"],
                "coworldImageID": public_image["id"],
                "coworldImageDigest": public_image["image_digest"],
                "publicImageURI": public_image["public_image_uri"],
                "materializationMode": image_upload["mode"],
                "summaryReceiptSha256": summary["receiptSha256"],
            }
        )
    )


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("command", choices=("check", "upload"))
    result.add_argument("--image", required=True)
    result.add_argument("--policy-name", required=True)
    result.add_argument("--policy-identity-sha256", required=True)
    result.add_argument("--source-sha", required=True)
    result.add_argument("--source-tree-sha", required=True)
    result.add_argument("--source-provenance-digest", required=True)
    result.add_argument("--build-provenance-digest", required=True)
    result.add_argument("--oci-digest", required=True)
    result.add_argument("--output", type=Path)
    result.add_argument("--recovery", type=Path)
    result.add_argument(
        "--allow-remote-adoption", choices=("true", "false"), default="false"
    )
    return result


def main() -> None:
    args = parser().parse_args()
    args.allow_remote_adoption = args.allow_remote_adoption == "true"
    validate_args(args)
    if args.command == "check":
        with CoworldUploadClient.from_login(server_url=SERVER) as client:
            if discover_exact_image(client, args) is not None:
                raise RuntimeError("Commander public base image already exists")
        with CoworldApiClient.from_login(server_url=SERVER) as read_client:
            if read_client.lookup_policy_version(name=args.policy_name) is not None:
                raise RuntimeError("Commander public base policy already exists")
        print(json.dumps({"ok": True, "namesAvailable": 1}))
        return
    materialize(args)


if __name__ == "__main__":
    main()
