from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Callable, Mapping
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from commissioners.common.adapters import (
    complete_round_for_round_start,
    describe_division_for_request,
    league_migration_config_for_request,
    migrate_league_for_request,
    rank_division_for_request,
    round_completed_for_request,
    schedule_episodes_for_round_start,
    schedule_rounds_for_request,
)
from commissioners.common.commissioners import Commissioner
from commissioners.common.protocol import (
    DescribeDivisionRequest,
    EpisodeAccepted,
    EpisodeCancel,
    EpisodeFailed,
    EpisodeRequest,
    EpisodeResult,
    EpisodesRejected,
    LeagueMigrationConfigRequest,
    LeagueMigrationRequest,
    RankDivisionRequest,
    RoundAbort,
    RoundCompletedRequest,
    RoundStart,
    ScheduleEpisodes,
    ScheduleRoundsRequest,
)

_MIN_EPISODE_DURATION_SECONDS = 5 * 60
_EXPLICIT_DURATION_KEYS = (
    "round_timeout_seconds",
    "server_duration_timeout_seconds",
    "server_duration_seconds",
    "episode_timeout_seconds",
    "duration_timeout_seconds",
    "duration_seconds",
    "time_limit_seconds",
    "timeout_seconds",
    "server_timeout_seconds",
)


def _positive_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        return None
    return float(value)


def _explicit_timeout_seconds(config: Mapping[str, Any]) -> float | None:
    for key in _EXPLICIT_DURATION_KEYS:
        value = _positive_number(config.get(key))
        if value is not None:
            return value
    for value in config.values():
        if isinstance(value, Mapping):
            nested = _explicit_timeout_seconds(value)
            if nested is not None:
                return nested
    return None


def _configured_episode_timeout_seconds(config: Mapping[str, Any]) -> float | None:
    timeout = _explicit_timeout_seconds(config)
    if timeout is not None:
        return timeout

    max_ticks = _positive_number(config.get("max_ticks"))
    tick_rate = _positive_number(config.get("tick_rate"))
    if max_ticks is not None and tick_rate is not None:
        return max_ticks / tick_rate

    return _positive_number(config.get("player_connect_timeout_seconds"))


def _episode_game_config(
    episode: EpisodeRequest, variants: dict[str, Any]
) -> Mapping[str, Any]:
    if episode.game_config is not None:
        return episode.game_config
    variant = variants[episode.variant_id]
    return variant.game_config


def _episode_duration_limit_seconds(
    episode: EpisodeRequest, variants: dict[str, Any]
) -> float | None:
    timeout = _configured_episode_timeout_seconds(
        _episode_game_config(episode, variants)
    )
    if timeout is None:
        return None
    return max(_MIN_EPISODE_DURATION_SECONDS, 2 * timeout)


def _episode_game_timeout_seconds(
    episode: EpisodeRequest, variants: dict[str, Any]
) -> float | None:
    return _configured_episode_timeout_seconds(_episode_game_config(episode, variants))


def _duration_text(seconds: float) -> str:
    if seconds.is_integer():
        return f"{int(seconds)} seconds"
    return f"{seconds:.1f} seconds"


# RFC 6455 caps a close frame's payload at 125 bytes, two of which carry the
# status code. `websockets` raises ProtocolError("control frame too long") past
# that, and because the raise happens inside the close call it escapes the
# handler -- uvicorn then drops the TCP connection with no close frame at all.
# The platform reports that as "no close frame received or sent" instead of our
# diagnostic close, which is exactly how a protocol rejection can masquerade as
# a lost pod. Trim by BYTES; slicing by characters is not the same budget.
_CLOSE_REASON_MAX_BYTES = 123


def _close_reason(text: str) -> str:
    return text.encode("utf-8")[:_CLOSE_REASON_MAX_BYTES].decode("utf-8", "ignore")


async def _close_socket(websocket: WebSocket, code: int, reason: str) -> None:
    await websocket.close(code=code, reason=_close_reason(reason))


async def _send_episode_batch(
    websocket: WebSocket,
    send_lock: asyncio.Lock,
    episodes: list[EpisodeRequest],
    mark_sent: Callable[[list[EpisodeRequest]], None],
) -> None:
    """Mark a batch sent only after its websocket transmission succeeds."""
    async with send_lock:
        await websocket.send_json(ScheduleEpisodes(episodes=episodes).to_json())
        mark_sent(episodes)


def create_app(commissioner: Commissioner) -> FastAPI:
    app = FastAPI()

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.websocket("/round")
    async def round_socket(websocket: WebSocket) -> None:
        await websocket.accept()
        round_start: RoundStart | None = None
        schedule: ScheduleEpisodes | None = None
        expected_request_ids: set[str] = set()
        queued_episodes: list[EpisodeRequest] = []
        sent_request_ids: set[str] = set()
        pending_ack_request_ids: set[str] = set()
        accepted_request_ids: set[str] = set()
        rejected_request_ids: set[str] = set()
        in_flight_request_ids: set[str] = set()
        results_by_request_id: dict[str, EpisodeResult] = {}
        failed_by_request_id: dict[str, EpisodeFailed] = {}
        cancel_tasks: dict[str, asyncio.Task[None]] = {}
        send_tasks: set[asyncio.Task[None]] = set()
        variants_by_id: dict[str, Any] = {}
        send_lock = asyncio.Lock()
        round_complete_sent = False
        throttle_config_fn = getattr(commissioner, "dispatch_throttle_config", None)
        throttle_config = throttle_config_fn() if callable(throttle_config_fn) else None

        def throttle_enabled() -> bool:
            return bool(getattr(throttle_config, "enabled", False))

        def max_in_flight(episode: EpisodeRequest) -> int:
            max_concurrent = getattr(throttle_config, "max_concurrent_episodes", None)
            if not callable(max_concurrent):
                return len(expected_request_ids) or 1
            return max_concurrent(
                _episode_game_timeout_seconds(episode, variants_by_id)
            )

        def stagger_seconds(episode: EpisodeRequest) -> float:
            stagger = getattr(throttle_config, "episode_stagger_seconds", None)
            if not callable(stagger):
                return 0.0
            return stagger(_episode_game_timeout_seconds(episode, variants_by_id))

        async def complete_round_if_settled() -> None:
            nonlocal round_complete_sent
            completed_request_ids = set(results_by_request_id)
            settled_request_ids = completed_request_ids | set(failed_by_request_id)
            if (
                round_start is None
                or schedule is None
                or not expected_request_ids
                or round_complete_sent
                or not expected_request_ids <= settled_request_ids
            ):
                return
            ordered_results = [
                results_by_request_id[request_id]
                for request_id in sorted(
                    completed_request_ids,
                    key=lambda value: int(value) if value.isdigit() else value,
                )
            ]
            round_complete_sent = True
            async with send_lock:
                await websocket.send_json(
                    complete_round_for_round_start(
                        commissioner,
                        round_start,
                        ordered_results,
                        schedule.episodes,
                        list(failed_by_request_id.values()),
                    ).to_json()
                )

        async def request_was_sent(request_id: str) -> bool:
            # A successful dispatch marks the request while holding this same
            # lock. If an immediate peer response races the send coroutine's
            # continuation, wait for that transport boundary before deciding.
            async with send_lock:
                return request_id in sent_request_ids

        def mark_episode_batch_sent(episodes: list[EpisodeRequest]) -> None:
            for episode in episodes:
                sent_request_ids.add(episode.request_id)
                pending_ack_request_ids.add(episode.request_id)
                schedule_episode_timeout(episode)

        async def send_episode_after_delay(
            episode: EpisodeRequest, delay_seconds: float
        ) -> None:
            if delay_seconds > 0:
                await asyncio.sleep(delay_seconds)
            if (
                episode.request_id in results_by_request_id
                or episode.request_id in failed_by_request_id
                or episode.request_id in rejected_request_ids
            ):
                return
            await _send_episode_batch(
                websocket,
                send_lock,
                [episode],
                mark_episode_batch_sent,
            )

        def schedule_episode_timeout(episode: EpisodeRequest) -> None:
            timeout_seconds = _episode_duration_limit_seconds(episode, variants_by_id)
            if timeout_seconds is not None:
                cancel_tasks[episode.request_id] = asyncio.create_task(
                    cancel_episode_after_timeout(episode.request_id, timeout_seconds)
                )

        async def fill_throttled_episode_window(*, initial: bool = False) -> None:
            if not queued_episodes:
                return
            next_episode = queued_episodes[0]
            if len(in_flight_request_ids) >= max_in_flight(next_episode):
                return
            # The dispatch websocket acknowledges each ScheduleEpisodes message
            # with episodes_accepted / episodes_rejected. Sending messages
            # back-to-back before an acknowledgement admitted only the first
            # episode in production, while batching several requests admitted
            # none. Keep max_in_flight as the concurrency ceiling, but open the
            # window one acknowledged request at a time.
            episode = queued_episodes.pop(0)
            # Reserve capacity immediately, but do not call the request sent or
            # start its timeout until websocket transmission succeeds.
            in_flight_request_ids.add(episode.request_id)
            interval = stagger_seconds(episode)
            delay = 0.0 if initial else interval
            if delay <= 0:
                await send_episode_after_delay(episode, delay)
            else:
                task = asyncio.create_task(send_episode_after_delay(episode, delay))
                send_tasks.add(task)
                task.add_done_callback(send_tasks.discard)

        async def cancel_episode_after_timeout(
            request_id: str, timeout_seconds: float
        ) -> None:
            await asyncio.sleep(timeout_seconds)
            if (
                request_id in results_by_request_id
                or request_id in failed_by_request_id
            ):
                return
            reason = f"Episode job duration exceeded {_duration_text(timeout_seconds)}"
            failed_by_request_id[request_id] = EpisodeFailed(
                request_id=request_id, error=reason
            )
            pending_ack_request_ids.discard(request_id)
            accepted_request_ids.discard(request_id)
            in_flight_request_ids.discard(request_id)
            async with send_lock:
                await websocket.send_json(
                    EpisodeCancel(request_id=request_id, reason=reason).to_json()
                )
            if throttle_enabled():
                await fill_throttled_episode_window()
            await complete_round_if_settled()

        try:
            while True:
                data = await websocket.receive_json()
                msg_type = data.get("type")

                if msg_type == "round_start":
                    round_start = RoundStart.model_validate(
                        {key: value for key, value in data.items() if key != "type"}
                    )
                    schedule = schedule_episodes_for_round_start(
                        commissioner, round_start
                    )
                    expected_request_ids = {
                        episode.request_id for episode in schedule.episodes
                    }
                    variants_by_id = {
                        variant.id: variant for variant in round_start.variants
                    }
                    if throttle_enabled():
                        queued_episodes = list(schedule.episodes)
                        await fill_throttled_episode_window(initial=True)
                    else:
                        await _send_episode_batch(
                            websocket,
                            send_lock,
                            schedule.episodes,
                            mark_episode_batch_sent,
                        )
                    if not expected_request_ids:
                        round_complete_sent = True
                        async with send_lock:
                            await websocket.send_json(
                                complete_round_for_round_start(
                                    commissioner,
                                    round_start,
                                    [],
                                    schedule.episodes,
                                    [],
                                ).to_json()
                            )
                    continue

                if msg_type == "schedule_rounds_request":
                    request = ScheduleRoundsRequest.model_validate(
                        {key: value for key, value in data.items() if key != "type"}
                    )
                    await websocket.send_json(
                        schedule_rounds_for_request(commissioner, request).to_json()
                    )
                    continue

                if msg_type == "league_migration_config_request":
                    request = LeagueMigrationConfigRequest.model_validate(
                        {key: value for key, value in data.items() if key != "type"}
                    )
                    await websocket.send_json(
                        league_migration_config_for_request(
                            commissioner, request
                        ).to_json()
                    )
                    continue

                if msg_type == "league_migration_request":
                    request = LeagueMigrationRequest.model_validate(
                        {key: value for key, value in data.items() if key != "type"}
                    )
                    await websocket.send_json(
                        migrate_league_for_request(commissioner, request).to_json()
                    )
                    continue

                if msg_type == "rank_division_request":
                    request = RankDivisionRequest.model_validate(
                        {key: value for key, value in data.items() if key != "type"}
                    )
                    await websocket.send_json(
                        rank_division_for_request(commissioner, request).to_json()
                    )
                    continue

                if msg_type == "describe_division_request":
                    request = DescribeDivisionRequest.model_validate(
                        {key: value for key, value in data.items() if key != "type"}
                    )
                    await websocket.send_json(
                        describe_division_for_request(commissioner, request).to_json()
                    )
                    continue

                if msg_type == "round_completed_request":
                    request = RoundCompletedRequest.model_validate(
                        {key: value for key, value in data.items() if key != "type"}
                    )
                    await websocket.send_json(
                        round_completed_for_request(commissioner, request).to_json()
                    )
                    continue

                if msg_type == "episode_result":
                    if round_start is None:
                        await _close_socket(websocket, 1008, "episode_result received before round_start")
                        return
                    result = EpisodeResult.model_validate(
                        {key: value for key, value in data.items() if key != "type"}
                    )
                    if (
                        expected_request_ids
                        and result.request_id not in expected_request_ids
                    ):
                        await _close_socket(websocket, 1008, f"unknown episode request id: {result.request_id!r}")
                        return
                    if not await request_was_sent(result.request_id):
                        await _close_socket(websocket, 1008, f"result for unknown or unsent episode request id: {result.request_id!r}")
                        return
                    previous_result = results_by_request_id.get(result.request_id)
                    if previous_result is not None:
                        if previous_result == result:
                            continue
                        await _close_socket(websocket, 1008, f"conflicting duplicate result for episode request id: {result.request_id!r}")
                        return
                    if result.request_id in failed_by_request_id:
                        await _close_socket(websocket, 1008, f"result contradicts prior terminal failure or rejection for episode request id: {result.request_id!r}")
                        return
                    task = cancel_tasks.pop(result.request_id, None)
                    if task is not None:
                        task.cancel()
                    pending_ack_request_ids.discard(result.request_id)
                    accepted_request_ids.discard(result.request_id)
                    in_flight_request_ids.discard(result.request_id)
                    results_by_request_id[result.request_id] = result
                elif msg_type == "episode_failed":
                    failed = EpisodeFailed.model_validate(
                        {key: value for key, value in data.items() if key != "type"}
                    )
                    if round_start is None:
                        await _close_socket(websocket, 1008, "episode_failed received before round_start")
                        return
                    if (
                        expected_request_ids
                        and failed.request_id not in expected_request_ids
                    ):
                        await _close_socket(websocket, 1008, f"unknown episode request id: {failed.request_id!r}")
                        return
                    if not await request_was_sent(failed.request_id):
                        await _close_socket(websocket, 1008, f"failure for unknown or unsent episode request id: {failed.request_id!r}")
                        return
                    if failed.request_id in results_by_request_id:
                        await _close_socket(websocket, 1008, f"failure contradicts prior result for episode request id: {failed.request_id!r}")
                        return
                    previous_failure = failed_by_request_id.get(failed.request_id)
                    if previous_failure is not None:
                        if (
                            failed.request_id not in rejected_request_ids
                            and previous_failure == failed
                        ):
                            continue
                        await _close_socket(websocket, 1008, f"failure contradicts prior terminal failure or rejection for episode request id: {failed.request_id!r}")
                        return
                    task = cancel_tasks.pop(failed.request_id, None)
                    if task is not None:
                        task.cancel()
                    pending_ack_request_ids.discard(failed.request_id)
                    accepted_request_ids.discard(failed.request_id)
                    in_flight_request_ids.discard(failed.request_id)
                    failed_by_request_id[failed.request_id] = failed
                elif msg_type == "episodes_accepted":
                    accepted = EpisodeAccepted.model_validate(
                        {key: value for key, value in data.items() if key != "type"}
                    )
                    newly_accepted_in_flight = False
                    for request_id in accepted.request_ids:
                        if (
                            request_id not in expected_request_ids
                            or not await request_was_sent(request_id)
                        ):
                            await _close_socket(websocket, 1008, f"accepted unknown or unsent episode request id: {request_id!r}")
                            return
                        if request_id in rejected_request_ids:
                            await _close_socket(websocket, 1008, f"accepted previously rejected episode request id: {request_id!r}")
                            return
                        # A terminal result may race ahead of the acknowledgement.
                        # Treat its later acceptance as idempotent rather than
                        # reopening capacity or restarting a timer.
                        if (
                            request_id in results_by_request_id
                            or request_id in failed_by_request_id
                        ):
                            continue
                        if request_id not in accepted_request_ids:
                            newly_accepted_in_flight = True
                        pending_ack_request_ids.discard(request_id)
                        accepted_request_ids.add(request_id)
                    if not newly_accepted_in_flight:
                        continue
                elif msg_type == "episodes_rejected":
                    rejected = EpisodesRejected.model_validate(
                        {key: value for key, value in data.items() if key != "type"}
                    )
                    rejected_in_flight = False
                    for request_id in rejected.request_ids:
                        if (
                            request_id not in expected_request_ids
                            or not await request_was_sent(request_id)
                        ):
                            await _close_socket(websocket, 1008, f"rejected unknown or unsent episode request id: {request_id!r}")
                            return
                        if request_id in accepted_request_ids or request_id in results_by_request_id:
                            await _close_socket(websocket, 1008, f"rejected previously accepted episode request id: {request_id!r}")
                            return
                        rejection_failure = EpisodeFailed(
                            request_id=request_id,
                            error=rejected.errors.get(
                                request_id, "platform rejected scheduled episode"
                            ),
                        )
                        if request_id in rejected_request_ids:
                            if failed_by_request_id.get(request_id) == rejection_failure:
                                continue
                            await _close_socket(websocket, 1008, f"conflicting duplicate rejection for episode request id: {request_id!r}")
                            return
                        if request_id in failed_by_request_id:
                            await _close_socket(websocket, 1008, f"rejection contradicts prior terminal failure for episode request id: {request_id!r}")
                            return
                        rejected_in_flight = True
                        rejected_request_ids.add(request_id)
                        pending_ack_request_ids.discard(request_id)
                        in_flight_request_ids.discard(request_id)
                        task = cancel_tasks.pop(request_id, None)
                        if task is not None:
                            task.cancel()
                        failed_by_request_id[request_id] = rejection_failure
                    if not rejected_in_flight:
                        continue
                elif msg_type == "round_abort":
                    RoundAbort.model_validate(
                        {key: value for key, value in data.items() if key != "type"}
                    )
                    await websocket.close(code=1000)
                    return
                else:
                    await _close_socket(
                        websocket, 1008, f"unknown message type: {msg_type!r}"
                    )
                    return

                if throttle_enabled():
                    await fill_throttled_episode_window()
                await complete_round_if_settled()
        except WebSocketDisconnect:
            return
        except (ValueError, ValidationError) as exc:
            await _close_socket(websocket, 1008, str(exc))
        except Exception as exc:
            # Anything else would escape the ASGI app; uvicorn then closes the
            # TCP transport with no close frame, which the platform reports as
            # "no close frame received or sent" -- wire-indistinguishable from
            # losing the pod, and the reason round 1357 could not be attributed.
            # Close deliberately with a diagnostic reason, then re-raise so
            # uvicorn still logs the traceback. asyncio.CancelledError is a
            # BaseException and is deliberately NOT caught here.
            with contextlib.suppress(Exception):
                await _close_socket(
                    websocket, 1011, f"commissioner error: {type(exc).__name__}: {exc}"
                )
            raise
        finally:
            for task in cancel_tasks.values():
                task.cancel()
            for task in send_tasks:
                task.cancel()

    return app
