from __future__ import annotations

import asyncio
from collections.abc import Mapping
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
        dispatched_request_ids: set[str] = set()
        in_flight_request_ids: set[str] = set()
        accepted_request_ids: set[str] = set()
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

        async def send_episode_after_delay(
            episode: EpisodeRequest, delay_seconds: float
        ) -> None:
            if delay_seconds > 0:
                await asyncio.sleep(delay_seconds)
            async with send_lock:
                await websocket.send_json(
                    ScheduleEpisodes(episodes=[episode]).to_json()
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
            # with episodes_accepted / episodes_rejected.  Sending several
            # messages back-to-back before that acknowledgement admitted only
            # the first episode in production; batching several episode
            # requests into one message admitted none.  Keep max_in_flight as
            # the concurrency ceiling, but open the window one acknowledged
            # request at a time.  A platform that does not emit acknowledgements
            # still progresses serially when the current episode settles.
            episode = queued_episodes.pop(0)
            dispatched_request_ids.add(episode.request_id)
            in_flight_request_ids.add(episode.request_id)
            schedule_episode_timeout(episode)
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
                        dispatched_request_ids.update(expected_request_ids)
                        async with send_lock:
                            await websocket.send_json(schedule.to_json())
                        for episode in schedule.episodes:
                            schedule_episode_timeout(episode)
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
                        await websocket.close(
                            code=1008,
                            reason="episode_result received before round_start",
                        )
                        return
                    result = EpisodeResult.model_validate(
                        {key: value for key, value in data.items() if key != "type"}
                    )
                    if (
                        expected_request_ids
                        and result.request_id not in expected_request_ids
                    ):
                        await websocket.close(
                            code=1008,
                            reason=f"unknown episode request id: {result.request_id!r}",
                        )
                        return
                    if result.request_id not in dispatched_request_ids:
                        await websocket.close(
                            code=1008,
                            reason=f"undispatched episode request id: {result.request_id!r}",
                        )
                        return
                    if (
                        result.request_id in failed_by_request_id
                        or result.request_id in results_by_request_id
                    ):
                        continue
                    task = cancel_tasks.pop(result.request_id, None)
                    if task is not None:
                        task.cancel()
                    in_flight_request_ids.discard(result.request_id)
                    results_by_request_id[result.request_id] = result
                elif msg_type == "episode_failed":
                    failed = EpisodeFailed.model_validate(
                        {key: value for key, value in data.items() if key != "type"}
                    )
                    if round_start is None:
                        await websocket.close(
                            code=1008,
                            reason="episode_failed received before round_start",
                        )
                        return
                    if (
                        expected_request_ids
                        and failed.request_id not in expected_request_ids
                    ):
                        await websocket.close(
                            code=1008,
                            reason=f"unknown episode request id: {failed.request_id!r}",
                        )
                        return
                    if failed.request_id not in dispatched_request_ids:
                        await websocket.close(
                            code=1008,
                            reason=f"undispatched episode request id: {failed.request_id!r}",
                        )
                        return
                    if (
                        failed.request_id in results_by_request_id
                        or failed.request_id in failed_by_request_id
                    ):
                        continue
                    task = cancel_tasks.pop(failed.request_id, None)
                    if task is not None:
                        task.cancel()
                    in_flight_request_ids.discard(failed.request_id)
                    failed_by_request_id[failed.request_id] = failed
                elif msg_type == "episodes_accepted":
                    accepted = EpisodeAccepted.model_validate(
                        {key: value for key, value in data.items() if key != "type"}
                    )
                    if any(
                        request_id not in dispatched_request_ids
                        for request_id in accepted.request_ids
                    ):
                        await websocket.close(
                            code=1008, reason="unknown accepted episode request id"
                        )
                        return
                    newly_accepted_in_flight = {
                        request_id
                        for request_id in accepted.request_ids
                        if request_id not in accepted_request_ids
                        and request_id in in_flight_request_ids
                    }
                    accepted_request_ids.update(accepted.request_ids)
                    if not newly_accepted_in_flight:
                        continue
                elif msg_type == "episodes_rejected":
                    rejected = EpisodesRejected.model_validate(
                        {key: value for key, value in data.items() if key != "type"}
                    )
                    if any(
                        request_id not in dispatched_request_ids
                        for request_id in rejected.request_ids
                    ):
                        await websocket.close(
                            code=1008, reason="unknown rejected episode request id"
                        )
                        return
                    rejected_in_flight = False
                    for request_id in rejected.request_ids:
                        if (
                            request_id in results_by_request_id
                            or request_id in failed_by_request_id
                        ):
                            continue
                        rejected_in_flight = True
                        task = cancel_tasks.pop(request_id, None)
                        if task is not None:
                            task.cancel()
                        in_flight_request_ids.discard(request_id)
                        failed_by_request_id[request_id] = EpisodeFailed(
                            request_id=request_id,
                            error=rejected.errors.get(
                                request_id, "platform rejected scheduled episode"
                            ),
                        )
                    if not rejected_in_flight:
                        continue
                elif msg_type == "round_abort":
                    RoundAbort.model_validate(
                        {key: value for key, value in data.items() if key != "type"}
                    )
                    await websocket.close(code=1000)
                    return
                else:
                    await websocket.close(
                        code=1008, reason=f"unknown message type: {msg_type!r}"
                    )
                    return

                if throttle_enabled():
                    await fill_throttled_episode_window()
                await complete_round_if_settled()
        except WebSocketDisconnect:
            return
        except (ValueError, ValidationError) as exc:
            await websocket.close(code=1008, reason=str(exc)[:120])
        finally:
            for task in cancel_tasks.values():
                task.cancel()
            for task in send_tasks:
                task.cancel()

    return app
