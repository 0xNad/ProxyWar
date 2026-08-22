export interface CommanderXpExternalPhaseReceiptV2 {
  schemaVersion: 2;
  authority: "github-actions-attested-ledger-v1";
  repository: "0xNad/ProxyWar";
  workflowPath: ".github/workflows/commander-xp-external-seal.yml";
  workflowID: string;
  workflowName: "Commander XP external seal";
  actor: "0xNad";
  triggeringActor: "0xNad";
  event: "workflow_dispatch";
  ref: "refs/heads/main";
  experimentID: string;
  preRegistrationSha256: string;
  behaviorBaseSha: string;
  behaviorBaseTreeSha: string;
  runnerEnvironment: "github-hosted";
  attestationPolicy: {
    repository: "0xNad/ProxyWar";
    signerWorkflow: "0xNad/ProxyWar/.github/workflows/commander-xp-external-seal.yml";
    sourceRef: "refs/heads/main";
    sourceDigest: string;
    signerDigest: string;
    denySelfHostedRunners: true;
  };
  collector: {
    artifactID: number;
    artifactName: string;
    artifactDigest: string;
    workflowRunID: number;
    workflowRunAttempt: number;
    workflowID: number;
    workflowPath: ".github/workflows/commander-xp-evidence.yml";
    workflowName: "Commander XP protected experiment evidence";
    actor: "0xNad";
    triggeringActor: "0xNad";
    headRepository: "0xNad/ProxyWar";
    event: "workflow_dispatch";
    ref: "refs/heads/main";
    headSha: string;
  };
  runId: string;
  attempt: number;
  headSha: string;
  treeSha: string;
  phase: "preregistration" | "provider-preflight" | "canary" | "confirmatory";
  completedAt: string;
  evidenceArtifact: {
    id: string;
    digest: string;
    aggregateSha256: string;
    attestedSubjectDigest: string;
    localSealSha256: string;
  };
  receiptArtifact: {
    id: string;
    digest: string;
    receiptSha256: string;
    attestedSubjectDigest: string;
  };
  ledgerSha256: string;
}

export interface CommanderXpRetainedPhaseArtifactV2 {
  id: string;
  digest: string;
  attestationID: string;
}

export interface CommanderXpPriorPhaseReceiptBindingV2 {
  path:
    | "commander-xp-prereg-ledger-v2.json"
    | "commander-xp-provider-preflight-ledger-v2.json"
    | "commander-xp-canary-ledger-v2.json";
  sha256: string;
  ledgerSha256: string;
  runId: string;
  attempt: number;
  evidenceArtifact: CommanderXpExternalPhaseReceiptV2["evidenceArtifact"];
  receiptArtifact: CommanderXpExternalPhaseReceiptV2["receiptArtifact"];
  ledgerArtifact: CommanderXpRetainedPhaseArtifactV2 & {
    ledgerSha256: string;
  };
  authorityArtifact: CommanderXpRetainedPhaseArtifactV2 & {
    receiptSha256: string;
  };
  terminalArtifact: CommanderXpRetainedPhaseArtifactV2 & {
    envelopeSha256: string;
  };
  localSealSha256: string;
  workflowPath: ".github/workflows/commander-xp-external-seal.yml";
  workflowID: string;
  workflowName: "Commander XP external seal";
  actor: "0xNad";
  triggeringActor: "0xNad";
  event: "workflow_dispatch";
  ref: "refs/heads/main";
  experimentID: string;
  behaviorBaseSha: string;
  behaviorBaseTreeSha: string;
  headSha: string;
  treeSha: string;
}
