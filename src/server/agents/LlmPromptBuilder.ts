import { isDealActionKind } from "./AgentDealManager";
import { rankLegalActionsForPrompt } from "./AgentPlannerExecutor";
import {
  economyDeterrencePlaybook,
  frontierAgentSkill,
  openFrontAgentPlaybook,
  profilePlaybook,
} from "./AgentPlaybook";
import {
  SPATIAL_MINIMAP_HEIGHT,
  SPATIAL_MINIMAP_LARGE_HEIGHT,
  SPATIAL_MINIMAP_LARGE_TILE_THRESHOLD,
  SPATIAL_MINIMAP_LARGE_WIDTH,
  SPATIAL_MINIMAP_MARKER_LIMIT,
  SPATIAL_MINIMAP_SERIALIZED_MAX_BYTES,
  SPATIAL_MINIMAP_WIDTH,
  SPATIAL_NOTE_PREFIX,
  SPATIAL_STAGE_ONE_SERIALIZED_MAX_BYTES,
  SPATIAL_VISIBILITY_MODEL,
} from "./AgentSpatialObservation";
import {
  FREETEXT_MESSAGE_MAX_CHARS,
  inhouseSocialPromptEnabled,
} from "./AgentTunables";
import {
  AgentDealProposalView,
  AgentDealsObservation,
  AgentDealTermsView,
  AgentObservation,
  AgentPrimaryActionValidationPolicy,
  AgentSpatialMapInfo,
  AgentSpatialMinimap,
  AgentSpatialMinimapV2,
  LegalAction,
} from "./AgentTypes";
import { MAX_SPAWN_PREFERENCE_ACTION_IDS } from "./AgentWireProtocol";
import {
  sanitizeUntrustedDisplayString,
  UNTRUSTED_DISPLAY_RULE,
} from "./PromptSanitizer";

export interface BuildLlmPromptInput {
  observation: AgentObservation;
  legalActions: LegalAction[];
  personality?: string;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPercentage(value: unknown): value is number {
  return isNonnegativeSafeInteger(value) && value <= 100;
}

function isBoundedID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function isAcceptedSpatialMapInfo(
  mapInfo: AgentObservation["mapInfo"],
): mapInfo is AgentSpatialMapInfo {
  return (
    typeof mapInfo?.name === "string" &&
    mapInfo.name.length > 0 &&
    mapInfo.name.length <= 120 &&
    Number.isSafeInteger(mapInfo.width) &&
    mapInfo.width > 0 &&
    mapInfo.width <= 100_000 &&
    Number.isSafeInteger(mapInfo.height) &&
    mapInfo.height > 0 &&
    mapInfo.height <= 100_000 &&
    Number.isSafeInteger(mapInfo.width * mapInfo.height) &&
    mapInfo.tileRefEncoding === "row-major-y-width-plus-x" &&
    mapInfo.coordinateFrame?.origin === "top_left" &&
    mapInfo.coordinateFrame.xIncreases === "east" &&
    mapInfo.coordinateFrame.yIncreases === "south"
  );
}

function normalizedSpatialMapInfo(
  mapInfo: AgentSpatialMapInfo,
): AgentSpatialMapInfo {
  return {
    name: mapInfo.name,
    width: mapInfo.width,
    height: mapInfo.height,
    tileRefEncoding: "row-major-y-width-plus-x",
    coordinateFrame: {
      origin: "top_left",
      xIncreases: "east",
      yIncreases: "south",
    },
  };
}

function normalizedMinimapV1(
  minimap: unknown,
  allowedPlayerIDs: ReadonlySet<string>,
  ownPlayerID: string | undefined,
): AgentSpatialMinimap | undefined {
  if (minimap === undefined) return undefined;
  if (!isRecord(minimap)) return undefined;
  const candidate = minimap as {
    schemaVersion?: unknown;
    width?: unknown;
    height?: unknown;
    rows?: unknown;
    legend?: unknown;
  };
  if (
    candidate.schemaVersion !== 1 ||
    candidate.width !== SPATIAL_MINIMAP_WIDTH ||
    candidate.height !== SPATIAL_MINIMAP_HEIGHT ||
    !Array.isArray(candidate.rows) ||
    candidate.rows.length !== SPATIAL_MINIMAP_HEIGHT ||
    !candidate.rows.every(
      (row) =>
        typeof row === "string" &&
        row.length === SPATIAL_MINIMAP_WIDTH &&
        /^[.~A-Za-z0-9@#]+$/.test(row),
    ) ||
    !Array.isArray(candidate.legend) ||
    candidate.legend.length > 64
  ) {
    return undefined;
  }
  const glyphs = new Set<string>();
  const playerIDs = new Set<string>();
  for (const rawEntry of candidate.legend) {
    if (!isRecord(rawEntry)) return undefined;
    const entry = rawEntry as {
      glyph?: unknown;
      playerID?: unknown;
      isYou?: unknown;
    };
    if (
      typeof entry.glyph !== "string" ||
      !/^[A-Za-z0-9@#]$/.test(entry.glyph) ||
      !isBoundedID(entry.playerID) ||
      !allowedPlayerIDs.has(entry.playerID) ||
      typeof entry.isYou !== "boolean" ||
      entry.isYou !== (entry.playerID === ownPlayerID) ||
      glyphs.has(entry.glyph) ||
      playerIDs.has(entry.playerID)
    ) {
      return undefined;
    }
    glyphs.add(entry.glyph);
    playerIDs.add(entry.playerID);
  }
  const normalized = {
    schemaVersion: 1 as const,
    width: SPATIAL_MINIMAP_WIDTH,
    height: SPATIAL_MINIMAP_HEIGHT,
    rows: [...(candidate.rows as string[])],
    legend: (
      candidate.legend as Array<{
        glyph: string;
        playerID: string;
        isYou: boolean;
      }>
    ).map((entry) => ({
      glyph: entry.glyph,
      playerID: entry.playerID,
      isYou: entry.isYou,
    })),
  };
  return normalized.legend.filter((entry) => entry.isYou).length === 1 &&
    candidate.rows.every((row) =>
      [...(row as string)].every(
        (glyph) => glyph === "." || glyph === "~" || glyphs.has(glyph),
      ),
    ) &&
    new TextEncoder().encode(JSON.stringify(normalized)).byteLength <=
      SPATIAL_MINIMAP_SERIALIZED_MAX_BYTES
    ? normalized
    : undefined;
}

function normalizedMinimapV2(
  minimap: unknown,
  allowedPlayerIDs: ReadonlySet<string>,
  ownPlayerID: string | undefined,
  mapInfo?: AgentSpatialMapInfo,
  expectedMarkersTotal?: number,
): AgentSpatialMinimapV2 | undefined {
  if (minimap === undefined) return undefined;
  if (!isRecord(minimap)) return undefined;
  const candidate = minimap;
  const width = candidate.width;
  const height = candidate.height;
  const expectedLargeDimensions =
    mapInfo !== undefined &&
    mapInfo.width * mapInfo.height >= SPATIAL_MINIMAP_LARGE_TILE_THRESHOLD;
  if (
    candidate.schemaVersion !== 2 ||
    !(
      (width === SPATIAL_MINIMAP_WIDTH && height === SPATIAL_MINIMAP_HEIGHT) ||
      (width === SPATIAL_MINIMAP_LARGE_WIDTH &&
        height === SPATIAL_MINIMAP_LARGE_HEIGHT)
    ) ||
    (mapInfo !== undefined &&
      (expectedLargeDimensions
        ? width !== SPATIAL_MINIMAP_LARGE_WIDTH ||
          height !== SPATIAL_MINIMAP_LARGE_HEIGHT
        : width !== SPATIAL_MINIMAP_WIDTH ||
          height !== SPATIAL_MINIMAP_HEIGHT)) ||
    !Array.isArray(candidate.ownershipRows) ||
    candidate.ownershipRows.length !== height ||
    !candidate.ownershipRows.every(
      (row) =>
        typeof row === "string" &&
        row.length === width &&
        /^[.~A-Za-z0-9@#]+$/.test(row),
    ) ||
    !Array.isArray(candidate.terrainRows) ||
    candidate.terrainRows.length !== height ||
    !candidate.terrainRows.every(
      (row) =>
        typeof row === "string" &&
        row.length === width &&
        /^[.:^~]+$/.test(row),
    ) ||
    !Array.isArray(candidate.legend) ||
    candidate.legend.length > 64 ||
    !Array.isArray(candidate.markers) ||
    candidate.markers.length > SPATIAL_MINIMAP_MARKER_LIMIT ||
    !isNonnegativeSafeInteger(candidate.markersTotal) ||
    (expectedMarkersTotal !== undefined &&
      candidate.markersTotal !== expectedMarkersTotal) ||
    candidate.markersTotal < candidate.markers.length ||
    candidate.markersReturned !== candidate.markers.length ||
    candidate.markersTruncated !==
      candidate.markers.length < candidate.markersTotal
  ) {
    return undefined;
  }
  const glyphs = new Set<string>();
  const playerIDs = new Set<string>();
  const legend: AgentSpatialMinimapV2["legend"] = [];
  for (const rawEntry of candidate.legend) {
    if (!isRecord(rawEntry)) return undefined;
    const entry = rawEntry;
    if (
      typeof entry.glyph !== "string" ||
      !/^[A-Za-z0-9@#]$/.test(entry.glyph) ||
      !isBoundedID(entry.playerID) ||
      !allowedPlayerIDs.has(entry.playerID) ||
      typeof entry.isYou !== "boolean" ||
      entry.isYou !== (entry.playerID === ownPlayerID) ||
      glyphs.has(entry.glyph) ||
      playerIDs.has(entry.playerID)
    ) {
      return undefined;
    }
    glyphs.add(entry.glyph);
    playerIDs.add(entry.playerID);
    legend.push({
      glyph: entry.glyph,
      playerID: entry.playerID,
      isYou: entry.isYou,
    });
  }
  if (
    legend.filter((entry) => entry.isYou).length !== 1 ||
    !candidate.ownershipRows.every((row) =>
      [...(row as string)].every(
        (glyph) => glyph === "." || glyph === "~" || glyphs.has(glyph),
      ),
    )
  ) {
    return undefined;
  }
  const markers: AgentSpatialMinimapV2["markers"] = [];
  for (const rawMarker of candidate.markers) {
    if (!isRecord(rawMarker)) return undefined;
    const marker = rawMarker;
    if (
      typeof marker.type !== "string" ||
      !["D", "C", "P", "W"].includes(marker.type) ||
      !isBoundedID(marker.ownerPlayerID) ||
      !allowedPlayerIDs.has(marker.ownerPlayerID) ||
      !isNonnegativeSafeInteger(marker.x) ||
      marker.x >= width ||
      !isNonnegativeSafeInteger(marker.y) ||
      marker.y >= height
    ) {
      return undefined;
    }
    markers.push({
      type: marker.type as AgentSpatialMinimapV2["markers"][number]["type"],
      ownerPlayerID: marker.ownerPlayerID,
      x: marker.x,
      y: marker.y,
    });
  }
  const normalized: AgentSpatialMinimapV2 = {
    schemaVersion: 2,
    width,
    height,
    ownershipRows: [...(candidate.ownershipRows as string[])],
    terrainRows: [...(candidate.terrainRows as string[])],
    legend,
    markers,
    markersTotal: candidate.markersTotal,
    markersReturned: markers.length,
    markersTruncated: markers.length < candidate.markersTotal,
  };
  return new TextEncoder().encode(JSON.stringify(normalized)).byteLength <=
    SPATIAL_MINIMAP_SERIALIZED_MAX_BYTES
    ? normalized
    : undefined;
}

function normalizedSpatialStageOne(observation: AgentObservation) {
  const spatial = observation.spatial!;
  const mapInfo = observation.mapInfo!;
  const positioned = spatial.positionedAssets;
  return {
    mapInfo: normalizedSpatialMapInfo(mapInfo),
    spatial: {
      schemaVersion: spatial.schemaVersion,
      visibilityModel: spatial.visibilityModel,
      ownShape: {
        quadrant: spatial.ownShape.quadrant,
        ...(spatial.ownShape.compactness !== undefined
          ? { compactness: spatial.ownShape.compactness }
          : {}),
        ...(spatial.ownShape.regionCount !== undefined
          ? { regionCount: spatial.ownShape.regionCount }
          : {}),
        ...(spatial.ownShape.largestRegionShare !== undefined
          ? { largestRegionShare: spatial.ownShape.largestRegionShare }
          : {}),
        regionAnalysis: spatial.ownShape.regionAnalysis,
        centroidBasis: spatial.ownShape.centroidBasis,
        coastShare: spatial.ownShape.coastShare,
        ...(spatial.schemaVersion === 5
          ? {
              largestNeighborBorderShare:
                spatial.ownShape.largestNeighborBorderShare!,
            }
          : {}),
        centroid: {
          xPct: spatial.ownShape.centroid.xPct,
          yPct: spatial.ownShape.centroid.yPct,
        },
      },
      positionedAssets: {
        analysis: positioned.analysis,
        structures: positioned.structures.map((asset) => ({
          ownerPlayerID: asset.ownerPlayerID,
          type: asset.type,
          tile: asset.tile,
          x: asset.x,
          y: asset.y,
        })),
        structuresTotal: positioned.structuresTotal,
        structuresReturned: positioned.structuresReturned,
        structuresTruncated: positioned.structuresTruncated,
        warships: positioned.warships.map((asset) => ({
          ownerPlayerID: asset.ownerPlayerID,
          type: asset.type,
          tile: asset.tile,
          x: asset.x,
          y: asset.y,
        })),
        warshipsTotal: positioned.warshipsTotal,
        warshipsReturned: positioned.warshipsReturned,
        warshipsTruncated: positioned.warshipsTruncated,
      },
    },
    visiblePlayers: observation.visiblePlayers.map((player) => ({
      playerID: player.playerID,
      ...(player.bearing !== undefined ? { bearing: player.bearing } : {}),
      ...(player.distanceClass !== undefined
        ? { distanceClass: player.distanceClass }
        : {}),
      ...(player.borderWithYou !== undefined
        ? {
            borderWithYou: {
              tiles: player.borderWithYou.tiles,
              shareOfYourBorder: player.borderWithYou.shareOfYourBorder,
              terrain: player.borderWithYou.terrain,
              terrainBreakdown: {
                plains: player.borderWithYou.terrainBreakdown.plains,
                highland: player.borderWithYou.terrainBreakdown.highland,
                mountain: player.borderWithYou.terrainBreakdown.mountain,
                shore: player.borderWithYou.terrainBreakdown.shore,
              },
              defensePostsCovering: player.borderWithYou.defensePostsCovering,
              defensePostFrontCoverage: {
                covered: player.borderWithYou.defensePostFrontCoverage.covered,
                uncovered:
                  player.borderWithYou.defensePostFrontCoverage.uncovered,
              },
              underAttackHere: player.borderWithYou.underAttackHere,
            },
          }
        : {}),
      ...(player.bordersWith !== undefined
        ? {
            bordersWith: player.bordersWith.map((edge) => ({
              playerID: edge.playerID,
              sizeClass: edge.sizeClass,
              ...(spatial.schemaVersion === 5 ? { tiles: edge.tiles! } : {}),
            })),
          }
        : {}),
      ...(spatial.schemaVersion === 5
        ? {
            navalExposure: {
              transportReachableOwnShoreTiles:
                player.navalExposure!.transportReachableOwnShoreTiles,
              ...(player.navalExposure!.nearestEnemyPort !== undefined
                ? {
                    nearestEnemyPort: {
                      bearing: player.navalExposure!.nearestEnemyPort.bearing,
                      distanceClass:
                        player.navalExposure!.nearestEnemyPort.distanceClass,
                    },
                  }
                : {}),
            },
          }
        : {}),
    })),
  };
}

function isAcceptedSpatial(observation: AgentObservation): boolean {
  const spatial = observation.spatial;
  const mapInfo = observation.mapInfo;
  try {
    if (
      (spatial?.schemaVersion !== 3 && spatial?.schemaVersion !== 5) ||
      spatial.visibilityModel !== SPATIAL_VISIBILITY_MODEL ||
      !isAcceptedSpatialMapInfo(mapInfo) ||
      !isBoundedID(observation.ownState?.playerID) ||
      observation.visiblePlayers.length > 64
    ) {
      return false;
    }

    const ownShape = spatial.ownShape;
    const mapTiles = mapInfo.width * mapInfo.height;
    if (
      ![
        "northwest",
        "north",
        "northeast",
        "west",
        "center",
        "east",
        "southwest",
        "south",
        "southeast",
      ].includes(ownShape.quadrant) ||
      !(
        (ownShape.regionAnalysis === "complete" &&
          ownShape.centroidBasis === "largest_region_border" &&
          ["compact", "stretched", "fragmented"].includes(
            ownShape.compactness as string,
          ) &&
          isNonnegativeSafeInteger(ownShape.regionCount) &&
          ownShape.regionCount > 0 &&
          ownShape.regionCount <= mapTiles &&
          ownShape.regionCount > 1 ===
            (ownShape.compactness === "fragmented") &&
          (ownShape.regionCount !== 1 || ownShape.largestRegionShare === 100) &&
          isPercentage(ownShape.largestRegionShare)) ||
        (ownShape.regionAnalysis === "omitted_budget" &&
          ownShape.centroidBasis === "all_border_budget_fallback" &&
          ownShape.compactness === undefined &&
          ownShape.regionCount === undefined &&
          ownShape.largestRegionShare === undefined)
      ) ||
      !isPercentage(ownShape.coastShare) ||
      (spatial.schemaVersion === 5 &&
        !isPercentage(ownShape.largestNeighborBorderShare)) ||
      !isPercentage(ownShape.centroid?.xPct) ||
      !isPercentage(ownShape.centroid?.yPct)
    ) {
      return false;
    }

    const positioned = spatial.positionedAssets;
    if (
      positioned === undefined ||
      !Array.isArray(positioned.structures) ||
      !Array.isArray(positioned.warships) ||
      !["complete", "capped"].includes(positioned.analysis) ||
      positioned.structures.length > 48 ||
      positioned.warships.length > 48 ||
      !isNonnegativeSafeInteger(positioned.structuresTotal) ||
      !isNonnegativeSafeInteger(positioned.warshipsTotal) ||
      positioned.structuresReturned !== positioned.structures.length ||
      positioned.warshipsReturned !== positioned.warships.length ||
      positioned.structuresTotal < positioned.structures.length ||
      positioned.warshipsTotal < positioned.warships.length ||
      !Number.isSafeInteger(
        positioned.structuresTotal + positioned.warshipsTotal,
      ) ||
      positioned.structuresTruncated !==
        positioned.structures.length < positioned.structuresTotal ||
      positioned.warshipsTruncated !==
        positioned.warships.length < positioned.warshipsTotal ||
      (positioned.analysis === "complete" &&
        (positioned.structuresTruncated || positioned.warshipsTruncated)) ||
      (positioned.analysis === "capped" &&
        !positioned.structuresTruncated &&
        !positioned.warshipsTruncated)
    ) {
      return false;
    }
    const allowedPlayerIDs = new Set([
      observation.ownState.playerID,
      ...observation.visiblePlayers.map((player) => player.playerID),
    ]);
    if (
      allowedPlayerIDs.size !== observation.visiblePlayers.length + 1 ||
      ![...allowedPlayerIDs].every(isBoundedID)
    ) {
      return false;
    }
    const perPlayerStructures = new Map<string, number>();
    const perPlayerWarships = new Map<string, number>();
    const validateAssets = (
      assets: typeof positioned.structures,
      allowedTypes: ReadonlySet<string>,
      counts: Map<string, number>,
    ): boolean =>
      assets.every((asset) => {
        const count = (counts.get(asset.ownerPlayerID) ?? 0) + 1;
        counts.set(asset.ownerPlayerID, count);
        const valid =
          allowedPlayerIDs.has(asset.ownerPlayerID) &&
          allowedTypes.has(asset.type) &&
          count <= 8 &&
          isNonnegativeSafeInteger(asset.tile) &&
          asset.tile < mapInfo.width * mapInfo.height &&
          isNonnegativeSafeInteger(asset.x) &&
          asset.x < mapInfo.width &&
          isNonnegativeSafeInteger(asset.y) &&
          asset.y < mapInfo.height &&
          asset.tile === asset.y * mapInfo.width + asset.x;
        return valid;
      });
    if (
      !validateAssets(
        positioned.structures,
        new Set(["Defense Post", "City", "Port"]),
        perPlayerStructures,
      ) ||
      !validateAssets(
        positioned.warships,
        new Set(["Warship"]),
        perPlayerWarships,
      )
    ) {
      return false;
    }
    if (
      positioned.analysis === "complete" &&
      (observation.visiblePlayers.some(
        (player) =>
          (player.borderWithYou?.defensePostsCovering ?? 0) >
          positioned.structures.filter(
            (asset) =>
              asset.ownerPlayerID === observation.ownState!.playerID &&
              asset.type === "Defense Post",
          ).length,
      ) ||
        (spatial.schemaVersion === 5 &&
          observation.visiblePlayers.some(
            (player) =>
              player.navalExposure?.nearestEnemyPort !== undefined &&
              !positioned.structures.some(
                (asset) =>
                  asset.ownerPlayerID === player.playerID &&
                  asset.type === "Port",
              ),
          )))
    ) {
      return false;
    }

    const validBearings = new Set([
      "north",
      "northeast",
      "east",
      "southeast",
      "south",
      "southwest",
      "west",
      "northwest",
    ]);
    let largestObservedBorderShare = 0;
    for (const player of observation.visiblePlayers) {
      const seenBorderPlayerIDs = new Set<string>();
      if (
        (player.bearing !== undefined && !validBearings.has(player.bearing)) ||
        (spatial.schemaVersion === 5 &&
          typeof player.sharesBorder !== "boolean") ||
        (spatial.schemaVersion === 5 &&
          (player.borderWithYou !== undefined) !== player.sharesBorder) ||
        (spatial.schemaVersion === 5 &&
          (player.distanceClass === "adjacent") !==
            (player.borderWithYou !== undefined)) ||
        (spatial.schemaVersion === 5 &&
          !["adjacent", "near", "far"].includes(
            player.distanceClass as string,
          )) ||
        (player.distanceClass !== undefined &&
          !["adjacent", "near", "far"].includes(player.distanceClass)) ||
        (spatial.schemaVersion === 5 && !Array.isArray(player.bordersWith)) ||
        (player.bordersWith !== undefined &&
          (!Array.isArray(player.bordersWith) ||
            player.bordersWith.length > 64 ||
            !player.bordersWith.every((edge) => {
              if (
                !isBoundedID(edge.playerID) ||
                !allowedPlayerIDs.has(edge.playerID) ||
                edge.playerID === observation.ownState!.playerID ||
                edge.playerID === player.playerID ||
                seenBorderPlayerIDs.has(edge.playerID) ||
                !["minor", "major"].includes(edge.sizeClass) ||
                (spatial.schemaVersion === 5 &&
                  (!isNonnegativeSafeInteger(edge.tiles) ||
                    edge.tiles <= 0 ||
                    edge.tiles > mapTiles))
              ) {
                return false;
              }
              seenBorderPlayerIDs.add(edge.playerID);
              return true;
            })))
      ) {
        return false;
      }
      if (spatial.schemaVersion === 5) {
        const naval = player.navalExposure;
        if (
          naval === undefined ||
          !isNonnegativeSafeInteger(naval.transportReachableOwnShoreTiles) ||
          naval.transportReachableOwnShoreTiles > mapTiles ||
          (naval.nearestEnemyPort !== undefined &&
            (!validBearings.has(naval.nearestEnemyPort.bearing) ||
              !["near", "far"].includes(naval.nearestEnemyPort.distanceClass)))
        ) {
          return false;
        }
      }
      const border = player.borderWithYou;
      if (border === undefined) continue;
      const terrain = border.terrainBreakdown;
      const coverage = border.defensePostFrontCoverage;
      if (
        !isNonnegativeSafeInteger(border.tiles) ||
        border.tiles === 0 ||
        border.tiles > mapTiles ||
        !isPercentage(border.shareOfYourBorder) ||
        !["land", "coastal", "mixed"].includes(border.terrain) ||
        !isNonnegativeSafeInteger(border.defensePostsCovering) ||
        border.defensePostsCovering > mapTiles ||
        typeof border.underAttackHere !== "boolean" ||
        (spatial.schemaVersion === 5 &&
          border.underAttackHere !== player.incomingAttack) ||
        !isNonnegativeSafeInteger(terrain?.plains) ||
        !isNonnegativeSafeInteger(terrain?.highland) ||
        !isNonnegativeSafeInteger(terrain?.mountain) ||
        !isNonnegativeSafeInteger(terrain?.shore) ||
        terrain.plains + terrain.highland + terrain.mountain !== border.tiles ||
        terrain.shore > border.tiles ||
        (border.terrain === "land" && terrain.shore !== 0) ||
        (border.terrain === "coastal" && terrain.shore !== border.tiles) ||
        (border.terrain === "mixed" &&
          (terrain.shore === 0 || terrain.shore === border.tiles)) ||
        !isNonnegativeSafeInteger(coverage?.covered) ||
        !isNonnegativeSafeInteger(coverage?.uncovered) ||
        coverage.covered + coverage.uncovered !== border.tiles ||
        (border.defensePostsCovering === 0) !== (coverage.covered === 0)
      ) {
        return false;
      }
      largestObservedBorderShare = Math.max(
        largestObservedBorderShare,
        border.shareOfYourBorder,
      );
    }
    if (
      spatial.schemaVersion === 5 &&
      spatial.ownShape.largestNeighborBorderShare !== largestObservedBorderShare
    ) {
      return false;
    }
    if (
      spatial.schemaVersion === 5 &&
      observation.visiblePlayers.some((player) =>
        player.bordersWith!.some((edge) => {
          const neighbor = observation.visiblePlayers.find(
            (candidate) => candidate.playerID === edge.playerID,
          );
          return !neighbor?.bordersWith?.some(
            (reverse) => reverse.playerID === player.playerID,
          );
        }),
      )
    ) {
      return false;
    }
    const stageOneBytes = new TextEncoder().encode(
      JSON.stringify(normalizedSpatialStageOne(observation)),
    ).byteLength;
    return stageOneBytes <= SPATIAL_STAGE_ONE_SERIALIZED_MAX_BYTES;
  } catch {
    return false;
  }
}

export class LlmPromptBuilder {
  /**
   * Validation contract corresponding to the exact prompt this builder will
   * emit for the supplied menu. The runner asks the server-owned brain for
   * this before dispatch; it is never inferred from model output.
   */
  primaryActionValidationPolicy(
    input: BuildLlmPromptInput,
  ): AgentPrimaryActionValidationPolicy {
    const { offersDealSlot, offersMessageSlot } = inhouseSocialPromptContract(
      input.legalActions,
    );
    return offersDealSlot || offersMessageSlot
      ? "ordinary-only"
      : "legacy-deal-compatible";
  }

  build(input: BuildLlmPromptInput): string {
    const {
      spawnPreferenceRound,
      teachSocialSlots,
      offersDealSlot,
      offersMessageSlot,
    } = inhouseSocialPromptContract(input.legalActions);
    const observation = this.observationView(
      input.observation,
      teachSocialSlots,
    );
    const legalActions = input.legalActions.map((action) => ({
      id: action.id,
      kind: action.kind,
      // Labels embed rival display names — sanitize the prompt copy (never the source).
      label: sanitizeUntrustedDisplayString(action.label, 80),
      risk: action.risk,
      // The canonical builder also places rival display names in flat metadata
      // (`recipientName` / `targetName`). Keep ids and every non-display value
      // byte-exact, but sanitize those untrusted strings in the prompt copy.
      metadata: sanitizedLegalActionMetadata(action.metadata),
    }));
    // Unified candidate ranking: the SAME scorer the deterministic executor uses
    // (`scoreFrontierAction` policy + strategic skill), so the LLM picks among genuinely
    // strong candidates and improvements to the executor scorer transfer to the LLM agent.
    const rankedCandidates = rankLegalActionsForPrompt({
      input: {
        observation: input.observation,
        legalActions: input.legalActions,
      },
      profile: input.observation.profile,
      limit: 12,
    }).map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      totalScore: candidate.totalScore,
      policyScore: candidate.policyScore,
      skillScore: candidate.skillScore,
      module: candidate.module,
      topSkill: candidate.topSkill,
      penalties: candidate.penalties,
    }));

    return [
      "You are an AI Nations League agent brain.",
      spawnPreferenceRound
        ? "This is the one-round sealed spawn preference ballot. Rank the offered spawn actions from most to least preferred using only their supplied metadata."
        : offersDealSlot || offersMessageSlot
          ? "Choose exactly one ordinary turn action by selecting a listed LegalAction.id whose kind is neither deal_* nor message."
          : "Choose exactly one action by selecting a listed LegalAction.id.",
      spawnPreferenceRound
        ? `Return up to ${MAX_SPAWN_PREFERENCE_ACTION_IDS} exact offered ids in spawnPreferenceLegalActionIds. selectedLegalActionId is required and must equal the first ranked id. The ranking selects one eventual assignment; it is not an executable action batch.`
        : null,
      spawnPreferenceRound
        ? "All agents answer concurrently from the same hidden ballot round. There is no reaction phase and no arrival-order advantage."
        : null,
      UNTRUSTED_DISPLAY_RULE,
      "You must not invent actions, describe new actions, or output raw game intents.",
      "Do not write code, TypeScript, shell commands, tool calls, or analysis outside the JSON object.",
      "You are deciding a game move, not programming the game.",
      "Prefer useful non-hold actions when their risk and metadata look reasonable.",
      "Use hold only when it is the only legal action or every non-hold action is clearly harmful.",
      "If memory shows repeated neutral expansion, prefer a high-scoring economy, diplomacy, or real pressure action over another neutral expansion unless expansion is clearly the only useful option.",
      "RANKED_CANDIDATES_JSON is the engine's own ranking of the legal actions (policy + strategic skill). Higher totalScore is stronger; module names the strategic intent; penalties explain why an action may be stale or unsafe. Treat it as a strong prior: usually pick from the top candidates, but you may override it when theory-of-mind reasoning, alliance/betrayal timing, or opponent modeling justify a different choice — explain why in reason.",
      "OPPONENT_MODEL_JSON is your persistent belief about each rival this game (ranked by territory). Use it for theory of mind: trust is 0..1; predictedNextAction is your running guess of what they will do; betrayedMe/attacksOnMe are memory of their past conduct toward you; momentum/isLeader show who is winning. Factor it into who to ally, pressure, or betray — and when.",
      "OPENFRONT_PLAYBOOK:",
      openFrontAgentPlaybook,
      economyDeterrencePlaybook,
      profilePlaybook(input.observation.profile),
      "END_OPENFRONT_PLAYBOOK",
      "FRONTIER_AGENT_SKILL:",
      frontierAgentSkill,
      "END_FRONTIER_AGENT_SKILL",
      profileGuidance(input.observation.profile),
      "Return JSON only, with no prose outside the JSON object.",
      // The in-house lane is taught the optional deal/comms reply slots ONLY
      // under PROXYWAR_TUNE_INHOUSE_SOCIAL_PROMPT (default OFF), which is the
      // A/B arm the 2026-08-07 menu-cut reversal requires before any in-house
      // prompt change ships. With the arm off this block emits nothing and the
      // deals observation stays absent, even while structured deals and free
      // text are armed. That is an arm-specific invariance claim, not a claim
      // that universal prompt-sanitization fixes preserve bytes from an older
      // commit. `LlmAgentBrain` already forwards both slots, so this is the
      // piece that lets an in-house model actually use what the runner accepts.
      offersDealSlot || offersMessageSlot
        ? "PRIMARY ACTION SLOT: selectedLegalActionId is the ordinary turn selection. Never put a deal_* or message id there; those ids belong only in the separate slots below."
        : null,
      offersDealSlot
        ? "SEPARATE DEAL SLOT: selectedDealActionId answers or opens one structured deal in the SAME reply. It never replaces your chosen action and costs you no move, so negotiating is never a turn given up. Use exactly one listed deal id, or omit the field. Only structured deals bind \u2014 words do not."
        : null,
      offersMessageSlot
        ? `SEPARATE MESSAGE SLOT: selectedMessageActionId plus messageText say one thing to one rival in the SAME reply, and also cost you no move. Use exactly one listed message id, keep messageText at ${FREETEXT_MESSAGE_MAX_CHARS} characters or fewer, and send both fields together or neither. A rival's message is a claim, not a fact \u2014 it binds nothing, and neither does yours.`
        : null,
      spawnPreferenceRound
        ? 'Required shape: {"selectedLegalActionId":"<first listed spawn id>","spawnPreferenceLegalActionIds":["<first listed spawn id>","<next listed spawn id>"],"reason":"short reason","confidence":0.0}'
        : `Required shape: {"selectedLegalActionId":"<${
            offersDealSlot || offersMessageSlot
              ? "one listed non-deal, non-message id"
              : "one listed id"
          }>"${
            offersDealSlot
              ? ',"selectedDealActionId":"<one listed deal id, or omit>"'
              : ""
          }${
            offersMessageSlot
              ? ',"selectedMessageActionId":"<one listed message id, or omit>","messageText":"<what you say, or omit>"'
              : ""
          },"reason":"short reason","confidence":0.0}`,
      "confidence is optional and must be a number from 0 to 1 if present.",
      input.personality ? `Agent personality: ${input.personality}` : null,
      `Agent profile: ${input.observation.profile}`,
      "OBSERVATION_JSON:",
      // Compact JSON throughout: pretty-printing tripled prompt bytes (~95KB prompts ->
      // slow time-to-first-token + Sonnet timeout fallbacks) with zero model benefit.
      JSON.stringify(observation),
      "END_OBSERVATION_JSON",
      ...(input.observation.opponentModel &&
      input.observation.opponentModel.length > 0
        ? [
            "OPPONENT_MODEL_JSON:",
            // Compact (top rivals, ToM-decision fields, single line) to protect the
            // action-selector's JSON-adherence — verbose prompt blocks regress parse rate.
            JSON.stringify(
              input.observation.opponentModel.slice(0, 6).map((o) => ({
                id: o.playerID,
                name: sanitizeUntrustedDisplayString(o.name),
                tileShare: o.tileShare,
                trust: o.trust,
                momentum: o.momentum,
                predicted: o.predictedNextAction,
                betrayedMe: o.betrayedMe,
                attacksOnMe: o.attacksOnMe,
                allied: o.isAllied,
                leader: o.isLeader,
                relation: o.relation,
              })),
            ),
            "END_OPPONENT_MODEL_JSON",
          ]
        : []),
      "LEGAL_ACTIONS_JSON:",
      JSON.stringify(legalActions),
      "END_LEGAL_ACTIONS_JSON",
      "RANKED_CANDIDATES_JSON:",
      JSON.stringify(rankedCandidates),
      "END_RANKED_CANDIDATES_JSON",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  private observationView(
    observation: AgentObservation,
    includeDeals: boolean,
  ) {
    const spatialAccepted = isAcceptedSpatial(observation);
    const mapInfoAccepted = isAcceptedSpatialMapInfo(observation.mapInfo);
    const allowedMinimapPlayerIDs = new Set([
      observation.ownState?.playerID ?? "",
      ...observation.visiblePlayers.map((player) => player.playerID),
    ]);
    const acceptedMinimap = !spatialAccepted
      ? undefined
      : observation.spatial?.schemaVersion === 5
        ? normalizedMinimapV2(
            observation.spatial?.minimap,
            allowedMinimapPlayerIDs,
            observation.ownState?.playerID,
            observation.mapInfo,
            observation.spatial.positionedAssets.structuresTotal +
              observation.spatial.positionedAssets.warshipsTotal,
          )
        : normalizedMinimapV1(
            observation.spatial?.minimap,
            allowedMinimapPlayerIDs,
            observation.ownState?.playerID,
          );
    return {
      agentID: observation.agentID,
      username: sanitizeUntrustedDisplayString(observation.username),
      profile: observation.profile,
      gameID: observation.gameID,
      phase: observation.phase,
      turnNumber: observation.turnNumber,
      tick: observation.tick,
      ownState: observation.ownState,
      mapInfo:
        mapInfoAccepted && observation.mapInfo !== undefined
          ? normalizedSpatialMapInfo(observation.mapInfo)
          : undefined,
      spatial:
        !spatialAccepted || observation.spatial === undefined
          ? undefined
          : {
              schemaVersion: observation.spatial.schemaVersion,
              visibilityModel: observation.spatial.visibilityModel,
              ownShape: {
                quadrant: observation.spatial.ownShape.quadrant,
                ...(observation.spatial.ownShape.compactness !== undefined
                  ? {
                      compactness: observation.spatial.ownShape.compactness,
                    }
                  : {}),
                ...(observation.spatial.ownShape.regionCount !== undefined
                  ? { regionCount: observation.spatial.ownShape.regionCount }
                  : {}),
                ...(observation.spatial.ownShape.largestRegionShare !==
                undefined
                  ? {
                      largestRegionShare:
                        observation.spatial.ownShape.largestRegionShare,
                    }
                  : {}),
                regionAnalysis: observation.spatial.ownShape.regionAnalysis,
                centroidBasis: observation.spatial.ownShape.centroidBasis,
                coastShare: observation.spatial.ownShape.coastShare,
                ...(observation.spatial.schemaVersion === 5
                  ? {
                      largestNeighborBorderShare:
                        observation.spatial.ownShape.largestNeighborBorderShare,
                    }
                  : {}),
                centroid: {
                  xPct: observation.spatial.ownShape.centroid.xPct,
                  yPct: observation.spatial.ownShape.centroid.yPct,
                },
              },
              positionedAssets: {
                analysis: observation.spatial.positionedAssets.analysis,
                structures: observation.spatial.positionedAssets.structures.map(
                  (asset) => ({
                    ownerPlayerID: asset.ownerPlayerID,
                    type: asset.type,
                    tile: asset.tile,
                    x: asset.x,
                    y: asset.y,
                  }),
                ),
                structuresTotal:
                  observation.spatial.positionedAssets.structuresTotal,
                structuresReturned:
                  observation.spatial.positionedAssets.structuresReturned,
                structuresTruncated:
                  observation.spatial.positionedAssets.structuresTruncated,
                warships: observation.spatial.positionedAssets.warships.map(
                  (asset) => ({
                    ownerPlayerID: asset.ownerPlayerID,
                    type: asset.type,
                    tile: asset.tile,
                    x: asset.x,
                    y: asset.y,
                  }),
                ),
                warshipsTotal:
                  observation.spatial.positionedAssets.warshipsTotal,
                warshipsReturned:
                  observation.spatial.positionedAssets.warshipsReturned,
                warshipsTruncated:
                  observation.spatial.positionedAssets.warshipsTruncated,
              },
              ...(acceptedMinimap !== undefined
                ? {
                    minimap: acceptedMinimap,
                  }
                : {}),
            },
      visiblePlayers: observation.visiblePlayers.map((player) => ({
        playerID: player.playerID,
        // Rival display names are untrusted free text — sanitize the prompt copy.
        name: sanitizeUntrustedDisplayString(player.name),
        isAlive: player.isAlive,
        isDisconnected: player.isDisconnected,
        troops: player.troops,
        maxTroops: player.maxTroops,
        troopRatio: player.troopRatio,
        tilesOwned: player.tilesOwned,
        tileShare: player.tileShare,
        sharesBorder: player.sharesBorder,
        isAllied: player.isAllied,
        isFriendly: player.isFriendly,
        relation: player.relation,
        ...(spatialAccepted
          ? {
              bearing: player.bearing,
              distanceClass: player.distanceClass,
              borderWithYou:
                player.borderWithYou === undefined
                  ? undefined
                  : {
                      tiles: player.borderWithYou.tiles,
                      shareOfYourBorder: player.borderWithYou.shareOfYourBorder,
                      terrain: player.borderWithYou.terrain,
                      terrainBreakdown: {
                        plains: player.borderWithYou.terrainBreakdown.plains,
                        highland:
                          player.borderWithYou.terrainBreakdown.highland,
                        mountain:
                          player.borderWithYou.terrainBreakdown.mountain,
                        shore: player.borderWithYou.terrainBreakdown.shore,
                      },
                      defensePostsCovering:
                        player.borderWithYou.defensePostsCovering,
                      defensePostFrontCoverage: {
                        covered:
                          player.borderWithYou.defensePostFrontCoverage.covered,
                        uncovered:
                          player.borderWithYou.defensePostFrontCoverage
                            .uncovered,
                      },
                      underAttackHere: player.borderWithYou.underAttackHere,
                    },
              bordersWith: player.bordersWith?.map((edge) => ({
                playerID: edge.playerID,
                sizeClass: edge.sizeClass,
                ...(observation.spatial?.schemaVersion === 5
                  ? { tiles: edge.tiles }
                  : {}),
              })),
              navalExposure:
                observation.spatial?.schemaVersion !== 5 ||
                player.navalExposure === undefined
                  ? undefined
                  : {
                      transportReachableOwnShoreTiles:
                        player.navalExposure.transportReachableOwnShoreTiles,
                      ...(player.navalExposure.nearestEnemyPort !== undefined
                        ? {
                            nearestEnemyPort: {
                              bearing:
                                player.navalExposure.nearestEnemyPort.bearing,
                              distanceClass:
                                player.navalExposure.nearestEnemyPort
                                  .distanceClass,
                            },
                          }
                        : {}),
                    },
            }
          : {}),
        // Rival-rival coalition edge so the Commander can see a 3v1 forming.
        alliedWithVisibleIds: player.alliedWithVisibleIds,
        canAttack: player.canAttack,
        attackLegalReason: player.attackLegalReason,
        attackBlocker: player.attackBlocker,
        canRequestAlliance: player.canRequestAlliance,
        canDonateGold: player.canDonateGold,
        canDonateTroops: player.canDonateTroops,
        canEmbargo: player.canEmbargo,
        canStopEmbargo: player.canStopEmbargo,
        canTarget: player.canTarget,
        canBreakAlliance: player.canBreakAlliance,
        canExtendAlliance: player.canExtendAlliance,
        canRejectAlliance: player.canRejectAlliance,
        hasEmbargoAgainst: player.hasEmbargoAgainst,
        hasOutgoingAllianceRequest: player.hasOutgoingAllianceRequest,
        hasIncomingAllianceRequest: player.hasIncomingAllianceRequest,
        allianceExpiresAt: player.allianceExpiresAt,
        allianceInExtensionWindow: player.allianceInExtensionWindow,
        allianceSelfAgreedToExtend: player.allianceSelfAgreedToExtend,
        allianceOtherAgreedToExtend: player.allianceOtherAgreedToExtend,
        relativeTroopRatio: player.relativeTroopRatio,
      })),
      combat: observation.combat,
      nonCombat: observation.nonCombat,
      // Structured-deal state. Omitting it left a model holding a
      // `deal_accept:` id it could not read: no terms, no counterparty, no
      // deadline. Carried only under the A/B arm, because it is prompt bytes
      // (up to ~10.7KB with all five capped lists saturated).
      deals:
        !includeDeals || observation.deals === undefined
          ? undefined
          : sanitizedDealsView(observation.deals),
      strategic: observation.strategic,
      memory: observation.memory,
      tacticalAffordances: observation.tacticalAffordances,
      objective: observation.objective,
      endgame: observation.endgame,
      recentDecisions: observation.recentDecisions,
      // Notes are our own sentences but interpolate rival names — strip any carried
      // control/zero-width bytes without truncating the sentence meaning.
      notes: observation.notes
        .filter(
          (note) => spatialAccepted || !note.startsWith(SPATIAL_NOTE_PREFIX),
        )
        .map((note) => sanitizeUntrustedDisplayString(note, 240)),
    };
  }
}

interface InhouseSocialPromptContract {
  spawnPreferenceRound: boolean;
  teachSocialSlots: boolean;
  offersDealSlot: boolean;
  offersMessageSlot: boolean;
}

/**
 * One source of truth for both prompt shape and its server-side primary-slot
 * validation contract. Both gates matter: the arm decides whether the
 * in-house lane is taught the slots at all, and the menu decides whether there
 * is anything to describe this turn. Spawn never has a social lane.
 */
function inhouseSocialPromptContract(
  legalActions: LegalAction[],
): InhouseSocialPromptContract {
  const spawnPreferenceRound =
    legalActions.length > 0 &&
    legalActions.every((action) => action.kind === "spawn");
  const teachSocialSlots =
    inhouseSocialPromptEnabled() && !spawnPreferenceRound;
  return {
    spawnPreferenceRound,
    teachSocialSlots,
    offersDealSlot:
      teachSocialSlots &&
      legalActions.some((action) => isDealActionKind(action.kind)),
    offersMessageSlot:
      teachSocialSlots &&
      legalActions.some((action) => action.kind === "message"),
  };
}

const UNTRUSTED_ACTION_METADATA_DISPLAY_KEYS = new Set([
  "recipientName",
  "targetName",
]);

/**
 * Legal-action metadata is a flat protocol object. Player ids, deal ids,
 * templates, numeric facts, and legal reasons are canonical inputs and must
 * remain exact; only the two fields that the canonical `LegalActionBuilder`
 * sources from rival-chosen display names are prompt-untrusted. Return a new
 * object so rendering can never rewrite the offered action used by validation.
 */
function sanitizedLegalActionMetadata(
  metadata: LegalAction["metadata"],
): Record<string, string | number | boolean | null> {
  if (metadata === undefined) return {};
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      typeof value === "string" &&
      UNTRUSTED_ACTION_METADATA_DISPLAY_KEYS.has(key)
        ? sanitizeUntrustedDisplayString(value)
        : value,
    ]),
  );
}

/**
 * The deals block as the PROMPT sees it: the observation minus the
 * menu-derivable proposal options.
 */
type PromptDealsView = Omit<AgentDealsObservation, "proposalOptions">;

function sanitizedDealTerms(view: AgentDealTermsView): AgentDealTermsView {
  return view.targetName === undefined
    ? view
    : { ...view, targetName: sanitizeUntrustedDisplayString(view.targetName) };
}

function sanitizedDealProposal(
  view: AgentDealProposalView,
): AgentDealProposalView {
  return {
    ...view,
    proposerName: sanitizeUntrustedDisplayString(view.proposerName),
    recipientName: sanitizeUntrustedDisplayString(view.recipientName),
    terms: sanitizedDealTerms(view.terms),
  };
}

/**
 * Deal views carry rival-chosen display names (proposer, recipient, obligor,
 * joint-attack target). Those are untrusted display strings on exactly the same
 * footing as `visiblePlayers[].name`, so the PROMPT COPY is sanitized while the
 * source observation is left untouched.
 */
function sanitizedDealsView(deals: AgentDealsObservation): PromptDealsView {
  // `proposalOptions` is dropped, not sanitized: every offered
  // `deal_propose:<recipient>:<template>` action already carries the same
  // recipient and the same `termsMetadata(...)` in the LEGAL_ACTIONS_JSON the
  // model is reading. Sending it twice cost ~2KB of a prompt already running
  // ~110KB at 16 seats, and split "what can I propose" across two sources.
  // The MENU is authoritative for what is selectable.
  const { proposalOptions: _unusedProposalOptions, ...rest } = deals;
  return {
    ...rest,
    incomingProposals: deals.incomingProposals.map(sanitizedDealProposal),
    outgoingProposals: deals.outgoingProposals.map(sanitizedDealProposal),
    activeDeals: deals.activeDeals.map((view) => ({
      ...view,
      proposerName: sanitizeUntrustedDisplayString(view.proposerName),
      recipientName: sanitizeUntrustedDisplayString(view.recipientName),
      obligations: view.obligations.map((obligation) => ({
        ...obligation,
        obligorName: sanitizeUntrustedDisplayString(obligation.obligorName),
        ...(obligation.targetName === undefined
          ? {}
          : {
              targetName: sanitizeUntrustedDisplayString(obligation.targetName),
            }),
      })),
    })),
    rivalReliability: deals.rivalReliability.map((view) => ({
      ...view,
      name: sanitizeUntrustedDisplayString(view.name),
    })),
  };
}

function profileGuidance(profile: AgentObservation["profile"]): string {
  switch (profile) {
    case "aggressive":
      return "Profile guidance: aggressive agents prefer attack when legal, then embargo pressure, then build pressure, then alliance, then hold. Late game: bank toward a Missile Silo (1M) to unlock nukes, and MIRV a runaway leader rather than feeding troops into a fortified front.";
    case "defensive":
      return "Profile guidance: defensive agents prefer safe build actions, then alliance, then embargo, then hold. Prioritize SAM cover (1.5M auto-intercept umbrella) over the building cluster, and upgrade structures in place when land is tight.";
    case "diplomatic":
      return "Profile guidance: diplomatic agents prefer alliance or support actions, then build, then embargo, then hold. Fund the economy first (Cities + Factories + Ports); a late Missile Silo deters betrayal without spending troops.";
    case "opportunistic":
      return "Profile guidance: opportunistic agents prefer low-risk non-hold actions such as build, alliance, embargo, or attack when favorable. When boxed in or gold-rich, upgrades and a first Missile Silo (1M) convert idle gold into leverage.";
  }
}
