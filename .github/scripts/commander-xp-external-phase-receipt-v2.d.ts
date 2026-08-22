export interface CommanderXpExternalPhaseReceiptV2 {
  schemaVersion: 2;
  authority: "github-actions-attested-ledger-v1";
  repository: "0xNad/ProxyWar";
  workflowPath: ".github/workflows/commander-xp-external-seal.yml";
  workflowID: string;
  workflowName: "Commander XP external seal";
  actor: "0xNad";
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
    headRepository: "0xNad/ProxyWar";
    event: "workflow_dispatch";
    ref: "refs/heads/main";
  };
  runId: string;
  attempt: number;
  headSha: string;
  treeSha: string;
  phase: "provider-preflight" | "canary" | "confirmatory";
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
