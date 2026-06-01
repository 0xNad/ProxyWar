import fs from "fs/promises";
import path from "path";
import {
  AgentActionAuditStatus,
  AgentBrainType,
  AgentDecisionRecord,
  AgentStrategyProfile,
  LegalActionKind,
  legalActionKinds,
} from "./AgentTypes";

export interface AgentMatchStoryInput {
  runID: string;
  matchID: string;
  scenario: string;
  brainMode: AgentBrainType;
  records: AgentDecisionRecord[];
}

export interface AgentMatchStoryBeat {
  sequence: number;
  turnNumber: number;
  agent: string;
  profile: string;
  kind: string;
  actionID: string;
  headline: string;
  reason: string;
  accepted: boolean;
  fallbackUsed: boolean;
  auditStatus: AgentActionAuditStatus;
  latencyMs: number;
}

export type AgentProfileDifferentiationStallRisk = "low" | "medium" | "high";

export interface AgentProfileDifferentiationVector {
  hold: number;
  expansion: number;
  combat: number;
  economyBuild: number;
  defense: number;
  naval: number;
  strike: number;
  pressureSignal: number;
  diplomacySupport: number;
  communication: number;
}

export interface AgentProfileStorySummary {
  profile: AgentStrategyProfile;
  decisionCount: number;
  postSpawnDecisionCount: number;
  nonHoldRate: number;
  holdRate: number;
  expansionRate: number;
  combatRate: number;
  economyBuildRate: number;
  defenseRate: number;
  navalRate: number;
  strikeRate: number;
  pressureSignalRate: number;
  diplomacySupportRate: number;
  communicationRate: number;
  socialActionRate: number;
  uniqueActionKindCount: number;
  topActionKinds: string[];
  signatureScore: number;
  signatureMatched: boolean;
  signatureLabel: string;
  vector: AgentProfileDifferentiationVector;
}

export interface AgentProfileDifferentiationGate {
  profileCount: number;
  evaluatedProfileCount: number;
  distinctEnough: boolean;
  averagePairwiseDistance: number | null;
  stallRisk: AgentProfileDifferentiationStallRisk;
  summary: string;
  profiles: AgentProfileStorySummary[];
}

export interface AgentMatchStory {
  schemaVersion: 1;
  runID: string;
  matchID: string;
  scenario: string;
  brainMode: AgentBrainType;
  generatedAt: string;
  entertainmentScore: number;
  grade: "lively" | "promising" | "flat" | "stalled";
  summary: string;
  actionCounts: Partial<Record<LegalActionKind, number>>;
  actionDiversityCount: number;
  decisionCount: number;
  postSpawnDecisionCount: number;
  postSpawnNonHoldCount: number;
  nonHoldRate: number;
  acceptedRate: number;
  rejectedCount: number;
  fallbackCount: number;
  parserFailureCount: number;
  repeatedActionKindCount: number;
  repeatedExactActionCount: number;
  expansionActionCount: number;
  combatActionCount: number;
  buildActionCount: number;
  socialActionCount: number;
  holdCount: number;
  transportWaitHoldCount: number;
  attackSafetyHoldCount: number;
  supportCooldownHoldCount: number;
  unexplainedHoldCount: number;
  spectatorHighlights: string[];
  boringnessWarnings: string[];
  improvementSuggestions: string[];
  profileDifferentiation: AgentProfileDifferentiationGate;
  timeline: AgentMatchStoryBeat[];
}

export interface AgentMatchStoryPaths {
  jsonPath: string;
  markdownPath: string;
}

export function buildAgentMatchStory(
  input: AgentMatchStoryInput,
): AgentMatchStory {
  const postSpawn = input.records.filter(
    (record) => record.turnNumber > 0 && record.chosenActionKind !== "spawn",
  );
  const actionCounts = countActionKinds(input.records);
  const repeated = repeatedCounts(postSpawn);
  const expansionActionCount = input.records.filter(isExpansionAction).length;
  const combatActionCount = input.records.filter(isCombatAction).length;
  const buildActionCount = input.records.filter(
    (record) => record.chosenActionKind === "build",
  ).length;
  const socialActionCount = input.records.filter(isSocialAction).length;
  const holdCount = input.records.filter(
    (record) => record.chosenActionKind === "hold",
  ).length;
  const transportWaitHoldCount = input.records.filter(isTransportWaitHold).length;
  const attackSafetyHoldCount = input.records.filter(isAttackSafetyHold).length;
  const supportCooldownHoldCount = input.records.filter(
    isSupportCooldownHold,
  ).length;
  const unexplainedHoldCount = Math.max(
    0,
    holdCount -
      transportWaitHoldCount -
      attackSafetyHoldCount -
      supportCooldownHoldCount,
  );
  const rejectedCount = input.records.filter(
    (record) => !record.result.accepted,
  ).length;
  const fallbackCount = input.records.filter(fallbackUsed).length;
  const parserFailureCount = input.records.filter(parserFailed).length;
  const acceptedRate = rate(input.records.length - rejectedCount, input.records.length);
  const postSpawnNonHoldCount = postSpawn.filter(
    (record) => record.chosenActionKind !== "hold",
  ).length;
  const nonHoldRate = rate(postSpawnNonHoldCount, postSpawn.length);
  const actionDiversityCount = actionDiversity(input.records).size;
  const timeline = storyTimeline(input.records);
  const profileDifferentiation = buildProfileDifferentiationGate(input.records);
  const score = entertainmentScore({
    decisionCount: input.records.length,
    postSpawnDecisionCount: postSpawn.length,
    postSpawnNonHoldCount,
    nonHoldRate,
    acceptedRate,
    rejectedCount,
    fallbackCount,
    parserFailureCount,
    repeatedActionKindCount: repeated.kind,
    repeatedExactActionCount: repeated.exact,
    actionDiversityCount,
    expansionActionCount,
    combatActionCount,
    buildActionCount,
    socialActionCount,
    transportWaitHoldCount,
    attackSafetyHoldCount,
    supportCooldownHoldCount,
    profileDifferentiation,
  });
  const boringnessWarnings = boringnessWarningsFor({
    decisionCount: input.records.length,
    postSpawnDecisionCount: postSpawn.length,
    nonHoldRate,
    rejectedCount,
    fallbackCount,
    parserFailureCount,
    repeatedActionKindCount: repeated.kind,
    repeatedExactActionCount: repeated.exact,
    expansionActionCount,
    combatActionCount,
    buildActionCount,
    socialActionCount,
    holdCount,
    transportWaitHoldCount,
    attackSafetyHoldCount,
    supportCooldownHoldCount,
    unexplainedHoldCount,
    profileDifferentiation,
  });
  const spectatorHighlights = highlightsFor({
    records: input.records,
    timeline,
    expansionActionCount,
    combatActionCount,
    buildActionCount,
    socialActionCount,
    transportWaitHoldCount,
    attackSafetyHoldCount,
    supportCooldownHoldCount,
    profileDifferentiation,
    score,
  });
  const improvementSuggestions = suggestionsFor({
    boringnessWarnings,
    expansionActionCount,
    combatActionCount,
    buildActionCount,
    socialActionCount,
    repeatedActionKindCount: repeated.kind,
    repeatedExactActionCount: repeated.exact,
    parserFailureCount,
    fallbackCount,
    rejectedCount,
    transportWaitHoldCount,
    attackSafetyHoldCount,
    supportCooldownHoldCount,
    unexplainedHoldCount,
    profileDifferentiation,
  });
  const grade = gradeFor(score);

  return {
    schemaVersion: 1,
    runID: input.runID,
    matchID: input.matchID,
    scenario: input.scenario,
    brainMode: input.brainMode,
    generatedAt: new Date().toISOString(),
    entertainmentScore: score,
    grade,
    summary: summaryFor(score, grade, timeline, boringnessWarnings),
    actionCounts,
    actionDiversityCount,
    decisionCount: input.records.length,
    postSpawnDecisionCount: postSpawn.length,
    postSpawnNonHoldCount,
    nonHoldRate,
    acceptedRate,
    rejectedCount,
    fallbackCount,
    parserFailureCount,
    repeatedActionKindCount: repeated.kind,
    repeatedExactActionCount: repeated.exact,
    expansionActionCount,
    combatActionCount,
    buildActionCount,
    socialActionCount,
    holdCount,
    transportWaitHoldCount,
    attackSafetyHoldCount,
    supportCooldownHoldCount,
    unexplainedHoldCount,
    spectatorHighlights,
    boringnessWarnings,
    improvementSuggestions,
    profileDifferentiation,
    timeline,
  };
}

export async function writeAgentMatchStoryArtifacts(input: {
  story: AgentMatchStory;
  directory: string;
}): Promise<AgentMatchStoryPaths> {
  const jsonPath = path.join(input.directory, "match-story.json");
  const markdownPath = path.join(input.directory, "match-story.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(input.story, null, 2)}\n`);
  await fs.writeFile(markdownPath, agentMatchStoryMarkdown(input.story));
  return { jsonPath, markdownPath };
}

export function agentMatchStoryMarkdown(story: AgentMatchStory): string {
  return [
    `# Match Story ${story.runID}`,
    "",
    "## Spectator Summary",
    "",
    `- Entertainment score: ${story.entertainmentScore}/100 (${story.grade})`,
    `- Decisions: ${story.decisionCount}`,
    `- Post-spawn non-hold actions: ${story.postSpawnNonHoldCount}/${story.postSpawnDecisionCount} (${percent(story.nonHoldRate)})`,
    `- Transport-wait holds: ${story.transportWaitHoldCount}`,
    `- Attack-safety holds: ${story.attackSafetyHoldCount}`,
    `- Support-cooldown holds: ${story.supportCooldownHoldCount}`,
    `- Unexplained holds: ${story.unexplainedHoldCount}`,
    `- Action diversity: ${story.actionDiversityCount} action categories`,
    `- Accepted rate: ${percent(story.acceptedRate)}`,
    `- Repetition: ${story.repeatedActionKindCount} repeated kind(s), ${story.repeatedExactActionCount} exact repeat(s)`,
    "",
    story.summary,
    "",
    "## Highlights",
    "",
    ...(story.spectatorHighlights.length === 0
      ? ["- No spectator highlights were generated."]
      : story.spectatorHighlights.map((highlight) => `- ${highlight}`)),
    "",
    "## Boringness Warnings",
    "",
    ...(story.boringnessWarnings.length === 0
      ? ["- No major boringness warnings were detected."]
      : story.boringnessWarnings.map((warning) => `- ${warning}`)),
    "",
    "## Suggested Improvements",
    "",
    ...(story.improvementSuggestions.length === 0
      ? ["- Keep running longer matches and inspect the rendered replay."]
      : story.improvementSuggestions.map((suggestion) => `- ${suggestion}`)),
    "",
    "## Profile Differentiation Gate",
    "",
    `- Gate: ${story.profileDifferentiation.distinctEnough ? "distinct" : "needs review"}`,
    `- Profiles evaluated: ${story.profileDifferentiation.evaluatedProfileCount}/${story.profileDifferentiation.profileCount}`,
    `- Average pairwise distance: ${story.profileDifferentiation.averagePairwiseDistance ?? "n/a"}`,
    `- Stall risk: ${story.profileDifferentiation.stallRisk}`,
    "",
    story.profileDifferentiation.summary,
    "",
    story.profileDifferentiation.profiles.length === 0
      ? "No profile decisions were available for comparison."
      : markdownTable(
          [
            "Profile",
            "Signature",
            "Score",
            "Non-hold",
            "Combat",
            "Build",
            "Social",
            "Top Actions",
          ],
          story.profileDifferentiation.profiles.map((profile) => [
            profile.profile,
            profile.signatureLabel,
            `${profile.signatureScore}/100`,
            percent(profile.nonHoldRate),
            percent(profile.combatRate),
            percent(profile.economyBuildRate),
            percent(profile.socialActionRate),
            profile.topActionKinds.join(", ") || "none",
          ]),
        ),
    "",
    "## Story Timeline",
    "",
    story.timeline.length === 0
      ? "No story-worthy decisions were recorded."
      : markdownTable(
          ["#", "Turn", "Agent", "Kind", "Headline", "Result"],
          story.timeline.map((beat) => [
            String(beat.sequence),
            String(beat.turnNumber),
            beat.agent,
            beat.kind,
            beat.headline,
            beat.accepted ? "accepted" : "rejected",
          ]),
        ),
    "",
    "## Action Counts",
    "",
    "```json",
    JSON.stringify(story.actionCounts, null, 2),
    "```",
    "",
  ].join("\n");
}

function entertainmentScore(input: {
  decisionCount: number;
  postSpawnDecisionCount: number;
  postSpawnNonHoldCount: number;
  nonHoldRate: number;
  acceptedRate: number;
  rejectedCount: number;
  fallbackCount: number;
  parserFailureCount: number;
  repeatedActionKindCount: number;
  repeatedExactActionCount: number;
  actionDiversityCount: number;
  expansionActionCount: number;
  combatActionCount: number;
  buildActionCount: number;
  socialActionCount: number;
  transportWaitHoldCount: number;
  attackSafetyHoldCount: number;
  supportCooldownHoldCount: number;
  profileDifferentiation: AgentProfileDifferentiationGate;
}): number {
  const activity = input.nonHoldRate * 22;
  const diversity = Math.min(1, input.actionDiversityCount / 6) * 20;
  const reliability = input.acceptedRate * 18;
  const story =
    Math.min(1, input.expansionActionCount / 4) * 8 +
    Math.min(1, input.buildActionCount / 2) * 8 +
    Math.min(1, input.socialActionCount / 3) * 7 +
    Math.min(1, input.combatActionCount / 2) * 9;
  const duration = Math.min(1, input.postSpawnDecisionCount / 12) * 8;
  const transportPatienceCredit = Math.min(4, input.transportWaitHoldCount * 0.5);
  const explainedPatienceCredit = Math.min(
    3,
    (input.attackSafetyHoldCount + input.supportCooldownHoldCount) * 0.2,
  );
  const profileCredit =
    input.profileDifferentiation.evaluatedProfileCount < 2
      ? 0
      : input.profileDifferentiation.distinctEnough
        ? 4
        : -5;
  const profileStallPenalty =
    input.profileDifferentiation.stallRisk === "high"
      ? 5
      : input.profileDifferentiation.stallRisk === "medium"
        ? 2
        : 0;
  const repetitionPenalty =
    Math.min(18, input.repeatedActionKindCount * 2 + input.repeatedExactActionCount * 4);
  const failurePenalty =
    input.rejectedCount * 8 + input.fallbackCount * 6 + input.parserFailureCount * 8;
  return round(
    clamp(
      activity +
        diversity +
        reliability +
        story +
        duration +
        transportPatienceCredit +
        explainedPatienceCredit -
        profileStallPenalty +
        profileCredit -
        repetitionPenalty -
        failurePenalty,
      0,
      100,
    ),
  );
}

function boringnessWarningsFor(input: {
  decisionCount: number;
  postSpawnDecisionCount: number;
  nonHoldRate: number;
  rejectedCount: number;
  fallbackCount: number;
  parserFailureCount: number;
  repeatedActionKindCount: number;
  repeatedExactActionCount: number;
  expansionActionCount: number;
  combatActionCount: number;
  buildActionCount: number;
  socialActionCount: number;
  holdCount: number;
  transportWaitHoldCount: number;
  attackSafetyHoldCount: number;
  supportCooldownHoldCount: number;
  unexplainedHoldCount: number;
  profileDifferentiation: AgentProfileDifferentiationGate;
}): string[] {
  const warnings: string[] = [];
  if (input.decisionCount < 8) {
    warnings.push("Short run: not enough decisions for a satisfying spectator arc.");
  }
  if (
    input.postSpawnDecisionCount > 0 &&
    input.nonHoldRate < 0.6 &&
    input.transportWaitHoldCount >= Math.max(2, input.holdCount * 0.5)
  ) {
    warnings.push(
      "Many holds are transport-wait turns: the agent is waiting for boats to land, not simply frozen.",
    );
  } else if (input.postSpawnDecisionCount > 0 && input.nonHoldRate < 0.6) {
    warnings.push("Too many post-spawn holds; agents may look stalled.");
  }
  if (input.unexplainedHoldCount > Math.max(4, input.postSpawnDecisionCount * 0.25)) {
    warnings.push("Many holds lack a clear strategic explanation.");
  }
  if (
    input.attackSafetyHoldCount > Math.max(4, input.postSpawnDecisionCount * 0.2)
  ) {
    warnings.push(
      "Many holds are attack-safety waits: attacks were legal but blocked by reserve or target-risk policy.",
    );
  }
  if (
    input.supportCooldownHoldCount >
    Math.max(4, input.postSpawnDecisionCount * 0.2)
  ) {
    warnings.push(
      "Many holds occur when only support/diplomacy cleanup actions remain; the match may need clearer endgame conversion options.",
    );
  }
  if (input.expansionActionCount >= 4 && input.buildActionCount === 0 && input.combatActionCount === 0) {
    warnings.push("Expansion-heavy story with no builds or real combat pressure.");
  }
  if (input.repeatedExactActionCount > 2) {
    warnings.push("Repeated exact actions may feel scripted or stuck.");
  }
  if (input.repeatedActionKindCount > Math.max(3, input.postSpawnDecisionCount / 2)) {
    warnings.push("One action kind is repeated too often for varied viewing.");
  }
  if (input.socialActionCount > 4 && input.combatActionCount === 0) {
    warnings.push("Social actions are crowding out decisive pressure.");
  }
  if (
    input.profileDifferentiation.evaluatedProfileCount >= 2 &&
    !input.profileDifferentiation.distinctEnough
  ) {
    warnings.push(
      "Profiles are not visibly distinct enough; action mixes converge across personalities.",
    );
  }
  if (input.profileDifferentiation.stallRisk === "high") {
    warnings.push(
      "Profile story gate found high stall risk from too many holds or low-signal signatures.",
    );
  }
  if (profilesConvergedOnNeutralExpansion(input.profileDifferentiation)) {
    warnings.push(
      "Profiles are converging on neutral expansion instead of build, pressure, naval, or diplomacy beats.",
    );
  }
  if (input.rejectedCount > 0) {
    warnings.push(`${input.rejectedCount} rejected decision(s) interrupted the story.`);
  }
  if (input.fallbackCount > 0) {
    warnings.push(`${input.fallbackCount} fallback decision(s) made agent intent less clear.`);
  }
  if (input.parserFailureCount > 0) {
    warnings.push(`${input.parserFailureCount} parser failure(s) broke the agent contract.`);
  }
  return warnings;
}

function suggestionsFor(input: {
  boringnessWarnings: string[];
  expansionActionCount: number;
  combatActionCount: number;
  buildActionCount: number;
  socialActionCount: number;
  repeatedActionKindCount: number;
  repeatedExactActionCount: number;
  parserFailureCount: number;
  fallbackCount: number;
  rejectedCount: number;
  transportWaitHoldCount: number;
  attackSafetyHoldCount: number;
  supportCooldownHoldCount: number;
  unexplainedHoldCount: number;
  profileDifferentiation: AgentProfileDifferentiationGate;
}): string[] {
  const suggestions: string[] = [];
  if (input.parserFailureCount > 0 || input.fallbackCount > 0 || input.rejectedCount > 0) {
    suggestions.push("Fix parser/fallback/rejection issues before tuning spectacle.");
  }
  if (input.expansionActionCount >= 4 && input.buildActionCount === 0) {
    suggestions.push("After early expansion, push City or Factory builds or pressure actions so the replay develops.");
  }
  if (input.combatActionCount === 0) {
    suggestions.push("Expose and score safe pressure/attack opportunities once borders form.");
  }
  if (input.buildActionCount === 0) {
    suggestions.push("Add visible economy or defense build moments when legal and strategically useful.");
  }
  if (input.socialActionCount > 4 && input.combatActionCount === 0) {
    suggestions.push("Throttle diplomacy/embargo loops when direct pressure is available.");
  }
  if (input.repeatedExactActionCount > 2 || input.repeatedActionKindCount > 4) {
    suggestions.push("Use memory/repetition penalties to force plan refreshes and alternate action kinds.");
  }
  if (input.transportWaitHoldCount > 0) {
    suggestions.push("In spectator mode, label transport-wait turns and consider skipping ahead to the next landed invasion or legal border attack.");
  }
  if (input.attackSafetyHoldCount > 4) {
    suggestions.push("For attack-safety holds, expose the blocker summary in the replay and tune reserve/trigger thresholds only after confirming the attack would be favorable.");
  }
  if (input.supportCooldownHoldCount > 4) {
    suggestions.push("For support-cooldown holds, prefer new conquest, naval reach, or endgame infrastructure when available instead of support busy-work.");
  }
  if (input.unexplainedHoldCount > 4) {
    suggestions.push("Audit hold decisions without transport context; they may indicate missing LegalActions or overly strict scheduler blocking.");
  }
  if (
    input.profileDifferentiation.evaluatedProfileCount >= 2 &&
    !input.profileDifferentiation.distinctEnough
  ) {
    suggestions.push(
      "Tune profile-specific scoring so aggressive, defensive, diplomatic, and opportunistic agents produce different action mixes from the same LegalAction menu.",
    );
  }
  if (input.profileDifferentiation.stallRisk !== "low") {
    suggestions.push(
      "Use the profile differentiation gate to target boring hold/build loops before widening the benchmark.",
    );
  }
  if (profilesConvergedOnNeutralExpansion(input.profileDifferentiation)) {
    suggestions.push(
      "When neutral expansion dominates every profile, raise profile-specific build, bordered-rival pressure, naval, or social alternatives once they are legal.",
    );
  }
  if (input.boringnessWarnings.length === 0) {
    suggestions.push("Run a longer benchmark and inspect whether the match still has a midgame arc.");
  }
  return unique(suggestions);
}

function highlightsFor(input: {
  records: AgentDecisionRecord[];
  timeline: AgentMatchStoryBeat[];
  expansionActionCount: number;
  combatActionCount: number;
  buildActionCount: number;
  socialActionCount: number;
  transportWaitHoldCount: number;
  attackSafetyHoldCount: number;
  supportCooldownHoldCount: number;
  profileDifferentiation: AgentProfileDifferentiationGate;
  score: number;
}): string[] {
  const highlights: string[] = [];
  if (input.records.length > 0) {
    highlights.push(
      `${input.records.length} agent decision(s), ${input.timeline.length} story-worthy moment(s), and an entertainment score of ${input.score}/100.`,
    );
  }
  if (input.expansionActionCount > 0) {
    highlights.push(`${input.expansionActionCount} expansion action(s) pushed nations into new territory.`);
  }
  if (input.buildActionCount > 0) {
    highlights.push(`${input.buildActionCount} build action(s) created visible economy or defense moments.`);
  }
  if (input.socialActionCount > 0) {
    highlights.push(`${input.socialActionCount} diplomacy/social pressure action(s) shaped the match narrative.`);
  }
  if (input.combatActionCount > 0) {
    highlights.push(`${input.combatActionCount} hostile attack action(s) created direct conflict.`);
  }
  if (input.transportWaitHoldCount > 0) {
    highlights.push(`${input.transportWaitHoldCount} transport-wait hold(s) were explained as boats crossing before the next invasion.`);
  }
  if (input.attackSafetyHoldCount > 0) {
    highlights.push(`${input.attackSafetyHoldCount} attack-safety hold(s) conserved troops when legal attacks were too risky.`);
  }
  if (input.supportCooldownHoldCount > 0) {
    highlights.push(`${input.supportCooldownHoldCount} support-cooldown hold(s) avoided low-value diplomacy or support busy-work.`);
  }
  if (input.profileDifferentiation.distinctEnough) {
    highlights.push(
      `Profile differentiation gate found distinct action mixes: ${profileDifferentiationLabel(input.profileDifferentiation.profiles)}.`,
    );
  }
  for (const beat of input.timeline.slice(0, 4)) {
    highlights.push(beat.headline);
  }
  return unique(highlights).slice(0, 8);
}

function buildProfileDifferentiationGate(
  records: AgentDecisionRecord[],
): AgentProfileDifferentiationGate {
  const recordsByProfile = new Map<AgentStrategyProfile, AgentDecisionRecord[]>();
  for (const record of records) {
    const profileRecords = recordsByProfile.get(record.profile) ?? [];
    profileRecords.push(record);
    recordsByProfile.set(record.profile, profileRecords);
  }

  const profiles = [...recordsByProfile.entries()]
    .map(([profile, profileRecords]) => profileStorySummary(profile, profileRecords))
    .sort((left, right) => profileOrder(left.profile) - profileOrder(right.profile));
  const evaluatedProfiles = profiles.filter(
    (profile) => profile.postSpawnDecisionCount >= 2,
  );
  const averagePairwiseDistance =
    evaluatedProfiles.length < 2
      ? null
      : round(averageProfileDistance(evaluatedProfiles));
  const distinctEnough =
    evaluatedProfiles.length >= 2 &&
    averagePairwiseDistance !== null &&
    averagePairwiseDistance >= 0.14 &&
    evaluatedProfiles.some((profile) => profile.signatureMatched);
  const stallRisk = profileStallRisk(evaluatedProfiles, distinctEnough);

  return {
    profileCount: profiles.length,
    evaluatedProfileCount: evaluatedProfiles.length,
    distinctEnough,
    averagePairwiseDistance,
    stallRisk,
    summary: profileDifferentiationSummary(
      profiles,
      evaluatedProfiles,
      distinctEnough,
      averagePairwiseDistance,
      stallRisk,
    ),
    profiles,
  };
}

function profileStorySummary(
  profile: AgentStrategyProfile,
  records: AgentDecisionRecord[],
): AgentProfileStorySummary {
  const postSpawn = records.filter(
    (record) => record.turnNumber > 0 && record.chosenActionKind !== "spawn",
  );
  const denominator = postSpawn.length;
  const holdCount = postSpawn.filter(
    (record) => record.chosenActionKind === "hold",
  ).length;
  const nonHoldCount = denominator - holdCount;
  const expansionCount = postSpawn.filter(isNeutralExpansionLikeAction).length;
  const combatCount = postSpawn.filter(isDirectConflictAction).length;
  const economyBuildCount = postSpawn.filter(isEconomyBuildAction).length;
  const defenseCount = postSpawn.filter(isDefenseAction).length;
  const navalCount = postSpawn.filter(isNavalAction).length;
  const strikeCount = postSpawn.filter(
    (record) => record.chosenActionKind === "nuke",
  ).length;
  const pressureSignalCount = postSpawn.filter(isPressureSignalAction).length;
  const diplomacySupportCount = postSpawn.filter(isDiplomacySupportAction).length;
  const communicationCount = postSpawn.filter(isCommunicationAction).length;
  const socialActionCount = postSpawn.filter(isSocialAction).length;
  const uniqueActionKindCount = actionDiversity(postSpawn).size;
  const vector: AgentProfileDifferentiationVector = {
    hold: rate(holdCount, denominator),
    expansion: rate(expansionCount, denominator),
    combat: rate(combatCount, denominator),
    economyBuild: rate(economyBuildCount, denominator),
    defense: rate(defenseCount, denominator),
    naval: rate(navalCount, denominator),
    strike: rate(strikeCount, denominator),
    pressureSignal: rate(pressureSignalCount, denominator),
    diplomacySupport: rate(diplomacySupportCount, denominator),
    communication: rate(communicationCount, denominator),
  };
  const signatureScore = profileSignatureScore(
    profile,
    vector,
    uniqueActionKindCount,
  );

  return {
    profile,
    decisionCount: records.length,
    postSpawnDecisionCount: denominator,
    nonHoldRate: rate(nonHoldCount, denominator),
    holdRate: vector.hold,
    expansionRate: vector.expansion,
    combatRate: vector.combat,
    economyBuildRate: vector.economyBuild,
    defenseRate: vector.defense,
    navalRate: vector.naval,
    strikeRate: vector.strike,
    pressureSignalRate: vector.pressureSignal,
    diplomacySupportRate: vector.diplomacySupport,
    communicationRate: vector.communication,
    socialActionRate: rate(socialActionCount, denominator),
    uniqueActionKindCount,
    topActionKinds: topActionKindLabels(postSpawn),
    signatureScore,
    signatureMatched: denominator >= 2 && signatureScore >= 38 && vector.hold < 0.6,
    signatureLabel: profileSignatureLabel(profile, signatureScore),
    vector,
  };
}

function profileSignatureScore(
  profile: AgentStrategyProfile,
  vector: AgentProfileDifferentiationVector,
  uniqueActionKindCount: number,
): number {
  const diversity = Math.min(1, uniqueActionKindCount / 5);
  const nonHold = 1 - vector.hold;
  switch (profile) {
    case "aggressive":
      return round(
        clamp(
          vector.combat * 48 +
            vector.pressureSignal * 34 +
            vector.strike * 26 +
            vector.naval * 16 +
            nonHold * 14 +
            diversity * 12 -
            vector.diplomacySupport * 10 -
            vector.hold * 20,
          0,
          100,
        ),
      );
    case "defensive":
      return round(
        clamp(
          vector.defense * 46 +
            vector.economyBuild * 30 +
            vector.naval * 22 +
            vector.diplomacySupport * 16 +
            nonHold * 12 +
            diversity * 8 -
            vector.pressureSignal * 6 -
            vector.hold * 18,
          0,
          100,
        ),
      );
    case "diplomatic":
      return round(
        clamp(
          vector.diplomacySupport * 48 +
            vector.communication * 34 +
            vector.pressureSignal * 12 +
            vector.economyBuild * 8 +
            nonHold * 12 +
            diversity * 8 -
            vector.combat * 18 -
            vector.hold * 18,
          0,
          100,
        ),
      );
    case "opportunistic":
      return round(
        clamp(
          vector.expansion * 28 +
            vector.combat * 30 +
            vector.economyBuild * 24 +
            vector.naval * 18 +
            vector.pressureSignal * 12 +
            nonHold * 10 +
            diversity * 18 -
            vector.hold * 18,
          0,
          100,
        ),
      );
  }
}

function profileSignatureLabel(
  profile: AgentStrategyProfile,
  score: number,
): string {
  if (score < 38) {
    return `muted ${profile}`;
  }
  switch (profile) {
    case "aggressive":
      return "aggressive pressure";
    case "defensive":
      return "defensive posture";
    case "diplomatic":
      return "diplomatic support";
    case "opportunistic":
      return "opportunistic mixed play";
  }
}

function profileStallRisk(
  profiles: AgentProfileStorySummary[],
  distinctEnough: boolean,
): AgentProfileDifferentiationStallRisk {
  if (profiles.length === 0) {
    return "low";
  }
  const averageHoldRate =
    profiles.reduce((sum, profile) => sum + profile.holdRate, 0) / profiles.length;
  const mutedProfileCount = profiles.filter(
    (profile) =>
      !profile.signatureMatched ||
      profile.nonHoldRate < 0.45 ||
      profile.uniqueActionKindCount <= 1,
  ).length;
  if (
    averageHoldRate >= 0.45 ||
    mutedProfileCount >= Math.max(2, Math.ceil(profiles.length * 0.6))
  ) {
    return "high";
  }
  if (
    averageHoldRate >= 0.3 ||
    mutedProfileCount > 0 ||
    (profiles.length >= 2 && !distinctEnough)
  ) {
    return "medium";
  }
  return "low";
}

function profileDifferentiationSummary(
  profiles: AgentProfileStorySummary[],
  evaluatedProfiles: AgentProfileStorySummary[],
  distinctEnough: boolean,
  averagePairwiseDistance: number | null,
  stallRisk: AgentProfileDifferentiationStallRisk,
): string {
  if (profiles.length === 0) {
    return "No agent decisions were available for profile comparison.";
  }
  if (evaluatedProfiles.length < 2) {
    return `${profiles.length} profile(s) appeared, but fewer than two had enough post-spawn decisions for a profile differentiation gate.`;
  }
  const label = profileDifferentiationLabel(profiles);
  return distinctEnough
    ? `Profiles looked distinct enough for replay review (${label}); average action-mix distance ${averagePairwiseDistance}. Stall risk is ${stallRisk}.`
    : `Profiles need review: average action-mix distance ${averagePairwiseDistance}, stall risk ${stallRisk}, signatures ${label}.`;
}

function profileDifferentiationLabel(
  profiles: readonly AgentProfileStorySummary[],
): string {
  return profiles
    .filter((profile) => profile.postSpawnDecisionCount >= 2)
    .map((profile) => `${profile.profile}=${profile.signatureLabel}`)
    .join(", ");
}

function averageProfileDistance(profiles: AgentProfileStorySummary[]): number {
  let total = 0;
  let count = 0;
  for (let leftIndex = 0; leftIndex < profiles.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < profiles.length;
      rightIndex += 1
    ) {
      total += profileVectorDistance(
        profiles[leftIndex]!.vector,
        profiles[rightIndex]!.vector,
      );
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
}

function profileVectorDistance(
  left: AgentProfileDifferentiationVector,
  right: AgentProfileDifferentiationVector,
): number {
  const keys: (keyof AgentProfileDifferentiationVector)[] = [
    "hold",
    "expansion",
    "combat",
    "economyBuild",
    "defense",
    "naval",
    "strike",
    "pressureSignal",
    "diplomacySupport",
    "communication",
  ];
  const squaredDistance = keys.reduce((sum, key) => {
    const delta = left[key] - right[key];
    return sum + delta * delta;
  }, 0);
  return Math.sqrt(squaredDistance / keys.length);
}

function topActionKindLabels(records: AgentDecisionRecord[]): string[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    if (record.chosenActionKind === "spawn") {
      continue;
    }
    counts.set(
      record.chosenActionKind,
      (counts.get(record.chosenActionKind) ?? 0) + 1,
    );
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([kind, count]) => `${kind}(${count})`);
}

function profilesConvergedOnNeutralExpansion(
  gate: AgentProfileDifferentiationGate,
): boolean {
  const evaluatedProfiles = gate.profiles.filter(
    (profile) => profile.postSpawnDecisionCount >= 2,
  );
  return (
    evaluatedProfiles.length >= 2 &&
    evaluatedProfiles.every(
      (profile) =>
        profile.expansionRate >= 0.45 &&
        profile.combatRate < 0.2 &&
        profile.economyBuildRate < 0.2 &&
        profile.socialActionRate < 0.2,
    )
  );
}

function isDirectConflictAction(record: AgentDecisionRecord): boolean {
  if (record.chosenActionKind === "attack") {
    return !isExpansionAction(record);
  }
  if (record.chosenActionKind === "boat") {
    return actionTargetID(record) !== null;
  }
  return record.chosenActionKind === "nuke";
}

function isNeutralExpansionLikeAction(record: AgentDecisionRecord): boolean {
  if (isExpansionAction(record)) {
    return true;
  }
  return record.chosenActionKind === "boat" && actionTargetID(record) === null;
}

function isEconomyBuildAction(record: AgentDecisionRecord): boolean {
  if (
    record.chosenActionKind !== "build" &&
    record.chosenActionKind !== "upgrade_structure"
  ) {
    return false;
  }
  const text = metadataText(record);
  return (
    /economic|city|factory|port|trade|income|market/i.test(text) &&
    !/defense|sam|silo|missile/i.test(text)
  );
}

function isDefenseAction(record: AgentDecisionRecord): boolean {
  if (
    record.chosenActionKind === "retreat" ||
    record.chosenActionKind === "boat_retreat" ||
    record.chosenActionKind === "warship" ||
    record.chosenActionKind === "move_warship"
  ) {
    return true;
  }
  if (
    record.chosenActionKind !== "build" &&
    record.chosenActionKind !== "upgrade_structure"
  ) {
    return false;
  }
  return /defense|defence|sam|silo|missile|shield|fort|warship/i.test(
    metadataText(record),
  );
}

function isNavalAction(record: AgentDecisionRecord): boolean {
  return (
    record.chosenActionKind === "boat" ||
    record.chosenActionKind === "boat_retreat" ||
    record.chosenActionKind === "warship" ||
    record.chosenActionKind === "move_warship" ||
    record.chosenActionMetadata?.navalInvasion === true
  );
}

function isPressureSignalAction(record: AgentDecisionRecord): boolean {
  return [
    "target_player",
    "embargo",
    "embargo_all",
    "break_alliance",
    "alliance_reject",
  ].includes(record.chosenActionKind);
}

function isDiplomacySupportAction(record: AgentDecisionRecord): boolean {
  return [
    "alliance_request",
    "alliance_extend",
    "donate_gold",
    "donate_troops",
    "embargo_stop",
  ].includes(record.chosenActionKind);
}

function isCommunicationAction(record: AgentDecisionRecord): boolean {
  return record.chosenActionKind === "quick_chat" || record.chosenActionKind === "emoji";
}

function actionTargetID(record: AgentDecisionRecord): string | null {
  const metadata = record.chosenActionMetadata ?? {};
  for (const key of ["targetID", "recipientID", "playerID"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function metadataText(record: AgentDecisionRecord): string {
  return Object.values(record.chosenActionMetadata ?? {})
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value))
    .join(" ");
}

function profileOrder(profile: AgentStrategyProfile): number {
  switch (profile) {
    case "aggressive":
      return 0;
    case "defensive":
      return 1;
    case "diplomatic":
      return 2;
    case "opportunistic":
      return 3;
  }
}

function storyTimeline(records: AgentDecisionRecord[]): AgentMatchStoryBeat[] {
  return records
    .filter(
      (record) =>
        (record.chosenActionKind !== "hold" ||
          isTransportWaitHold(record) ||
          isAttackSafetyHold(record) ||
          isSupportCooldownHold(record)) &&
        (record.chosenActionKind !== "spawn" || record.turnNumber === 0),
    )
    .slice(0, 40)
    .map((record) => ({
      sequence: record.sequence,
      turnNumber: record.turnNumber,
      agent: record.username,
      profile: record.profile,
      kind: storyKind(record),
      actionID: record.chosenActionID,
      headline: headline(record),
      reason: record.reason,
      accepted: record.result.accepted,
      fallbackUsed: fallbackUsed(record),
      auditStatus: auditStatus(record),
      latencyMs: record.decisionLatencyMs,
    }));
}

function headline(record: AgentDecisionRecord): string {
  const metadata = record.chosenActionMetadata ?? {};
  switch (storyKind(record)) {
    case "spawn":
      return `${record.username} enters the map.`;
    case "expansion":
      return `${record.username} expands into neutral territory.`;
    case "attack":
      return `${record.username} pressures ${String(metadata.targetName ?? metadata.targetID ?? "a rival")}.`;
    case "build":
      return `${record.username} builds ${String(metadata.unit ?? "a structure")}.`;
    case "alliance":
      return `${record.username} seeks an alliance with ${String(metadata.recipientName ?? metadata.playerName ?? "another nation")}.`;
    case "support":
      return `${record.username} supports ${String(metadata.recipientName ?? "an ally")}.`;
    case "pressure":
      return `${record.username} applies pressure with ${record.chosenActionKind}.`;
    case "strike":
      return `${record.username} launches a late-game strike at ${String(metadata.targetName ?? metadata.targetID ?? "a strategic target")}.`;
    case "naval":
      return `${record.username} makes a naval move.`;
    case "naval_wait":
      return `${record.username} waits for transports to land before launching another wave.`;
    case "attack_safety_wait":
      return `${record.username} holds reserves because offered attacks are too risky.`;
    case "support_cooldown":
      return `${record.username} skips low-value support or diplomacy cleanup.`;
    default:
      return `${record.username} chooses ${record.chosenActionKind}.`;
  }
}

function storyKind(record: AgentDecisionRecord): string {
  if (isTransportWaitHold(record)) {
    return "naval_wait";
  }
  if (isAttackSafetyHold(record)) {
    return "attack_safety_wait";
  }
  if (isSupportCooldownHold(record)) {
    return "support_cooldown";
  }
  if (record.chosenActionKind === "attack" && isExpansionAction(record)) {
    return "expansion";
  }
  if (record.chosenActionKind === "spawn") {
    return "spawn";
  }
  if (record.chosenActionKind === "attack") {
    return "attack";
  }
  if (record.chosenActionKind === "nuke") {
    return "strike";
  }
  if (
    record.chosenActionKind === "build" ||
    record.chosenActionKind === "upgrade_structure"
  ) {
    return "build";
  }
  if (
    record.chosenActionKind === "alliance_request" ||
    record.chosenActionKind === "alliance_extend"
  ) {
    return "alliance";
  }
  if (
    record.chosenActionKind === "donate_gold" ||
    record.chosenActionKind === "donate_troops"
  ) {
    return "support";
  }
  if (
    record.chosenActionKind === "embargo" ||
    record.chosenActionKind === "embargo_all" ||
    record.chosenActionKind === "break_alliance" ||
    record.chosenActionKind === "target_player" ||
    record.chosenActionKind === "alliance_reject" ||
    record.chosenActionKind === "quick_chat" ||
    record.chosenActionKind === "emoji"
  ) {
    return "pressure";
  }
  if (
    record.chosenActionKind === "boat" ||
    record.chosenActionKind === "boat_retreat" ||
    record.chosenActionKind === "move_warship" ||
    record.chosenActionKind === "warship"
  ) {
    return "naval";
  }
  return record.chosenActionKind;
}

function isTransportWaitHold(record: AgentDecisionRecord): boolean {
  if (record.chosenActionKind !== "hold") {
    return false;
  }
  const text = `${record.reason} ${record.observationSummary}`;
  return (
    /waiting for active transport|transport to land|active transport/i.test(text) ||
    (/attackable=0/.test(text) && /boats=[1-9]/.test(text))
  );
}

function isAttackSafetyHold(record: AgentDecisionRecord): boolean {
  return (
    record.chosenActionKind === "hold" &&
    typeof record.decisionMetadata?.blockedHostileAttackSummary === "string" &&
    record.decisionMetadata.blockedHostileAttackSummary.length > 0
  );
}

function isSupportCooldownHold(record: AgentDecisionRecord): boolean {
  if (record.chosenActionKind !== "hold" || isTransportWaitHold(record) || isAttackSafetyHold(record)) {
    return false;
  }
  if (hasOfferedKind(record, [
    "attack",
    "boat",
    "build",
    "upgrade_structure",
    "retreat",
    "boat_retreat",
    "warship",
    "move_warship",
    "nuke",
    "embargo",
    "embargo_all",
    "target_player",
    "alliance_request",
  ])) {
    return false;
  }
  return hasOfferedKind(record, [
    "donate_gold",
    "donate_troops",
    "alliance_extend",
    "break_alliance",
    "embargo_stop",
    "delete_unit",
    "quick_chat",
    "emoji",
  ]);
}

function hasOfferedKind(
  record: AgentDecisionRecord,
  kinds: readonly LegalActionKind[],
): boolean {
  return kinds.some((kind) => (record.legalActionIDsByKind[kind]?.length ?? 0) > 0);
}

function isExpansionAction(record: AgentDecisionRecord): boolean {
  return (
    record.chosenActionKind === "attack" &&
    (record.chosenActionID.startsWith("expand:") ||
      record.chosenActionMetadata?.expansion === true ||
      record.chosenActionMetadata?.targetID === null)
  );
}

function isCombatAction(record: AgentDecisionRecord): boolean {
  return isDirectConflictAction(record);
}

function isSocialAction(record: AgentDecisionRecord): boolean {
  return [
    "alliance_request",
    "alliance_reject",
    "alliance_extend",
    "break_alliance",
    "target_player",
    "emoji",
    "quick_chat",
    "donate_gold",
    "donate_troops",
    "embargo",
    "embargo_stop",
    "embargo_all",
  ].includes(record.chosenActionKind);
}

function fallbackUsed(record: AgentDecisionRecord): boolean {
  return (
    record.decisionMetadata?.fallbackUsed === true ||
    record.decisionMetadata?.plannerFallbackUsed === true
  );
}

function parserFailed(record: AgentDecisionRecord): boolean {
  return (
    record.decisionMetadata?.parseSuccess === false ||
    record.decisionMetadata?.llmParseOk === false ||
    record.decisionMetadata?.plannerParseOk === false
  );
}

function auditStatus(record: AgentDecisionRecord): AgentActionAuditStatus {
  if (record.audit !== undefined) {
    return record.audit.auditStatus;
  }
  if (!record.result.accepted || record.intent === null || record.chosenActionKind === "hold") {
    return "not_applicable";
  }
  return "unknown";
}

function actionDiversity(records: AgentDecisionRecord[]): Set<string> {
  return new Set(records.map(storyKind).filter((kind) => kind !== "hold"));
}

function countActionKinds(
  records: AgentDecisionRecord[],
): Partial<Record<LegalActionKind, number>> {
  const counts: Partial<Record<LegalActionKind, number>> = {};
  for (const kind of legalActionKinds) {
    const count = records.filter((record) => record.chosenActionKind === kind).length;
    if (count > 0) {
      counts[kind] = count;
    }
  }
  return counts;
}

function repeatedCounts(records: AgentDecisionRecord[]): { kind: number; exact: number } {
  let kind = 0;
  let exact = 0;
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1]!;
    const current = records[index]!;
    if (
      current.chosenActionKind !== "hold" &&
      current.chosenActionKind === previous.chosenActionKind
    ) {
      kind += 1;
    }
    if (
      current.chosenActionID !== "hold" &&
      current.agentID === previous.agentID &&
      current.chosenActionID === previous.chosenActionID
    ) {
      exact += 1;
    }
  }
  return { kind, exact };
}

function summaryFor(
  score: number,
  grade: AgentMatchStory["grade"],
  timeline: AgentMatchStoryBeat[],
  warnings: string[],
): string {
  const base =
    timeline.length === 0
      ? "No story-worthy decisions were recorded."
      : `${timeline.length} story-worthy decision(s) were recorded.`;
  const warningText =
    warnings.length === 0
      ? "No major boringness warnings were detected."
      : `${warnings.length} boringness warning(s) need attention.`;
  return `${base} The run is graded ${grade} with ${score}/100. ${warningText}`;
}

function gradeFor(score: number): AgentMatchStory["grade"] {
  if (score >= 80) return "lively";
  if (score >= 60) return "promising";
  if (score >= 35) return "flat";
  return "stalled";
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(escapeMarkdownCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeMarkdownCell).join(" | ")} |`),
  ].join("\n");
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}
