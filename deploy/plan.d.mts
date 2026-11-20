export type DeploymentTransport = 'sftp' | 'vee-agent';
export type ArtifactKind = 'static' | 'php' | 'node' | 'python';
export type DeploymentCapability = 'transfer-only' | 'release-managed';

export interface DeploymentTarget {
  readonly id: string;
  readonly host: string;
  readonly port: number;
  readonly domain: string;
  readonly remoteRoot: string;
  readonly transport: DeploymentTransport;
  readonly hostKeyFingerprint?: string;
  readonly certificateFingerprint?: string;
}

export interface DeploymentArtifact {
  readonly projectId: string;
  readonly releaseId: string;
  readonly kind: ArtifactKind;
  readonly sha256: string;
  readonly byteSize: number;
}

export interface DeploymentRequest {
  readonly target: DeploymentTarget;
  readonly artifact: DeploymentArtifact;
  readonly previousReleaseId?: string;
  readonly healthPath?: string;
}

export type DeploymentOperation =
  | { readonly type: 'inspect-target'; readonly targetId: string }
  | { readonly type: 'stage-release'; readonly projectId: string; readonly releaseId: string; readonly sha256: string; readonly byteSize: number }
  | { readonly type: 'health-check'; readonly phase: 'staged' | 'live'; readonly path: string }
  | { readonly type: 'switch-release'; readonly projectId: string; readonly releaseId: string };

export interface RollbackOperation {
  readonly type: 'rollback-release';
  readonly projectId: string;
  readonly toReleaseId: string;
}

export interface DeploymentReview {
  readonly state: 'pending' | 'reviewed' | 'approved';
  readonly reviewedAt: string | null;
  readonly approvedAt: string | null;
  readonly reviewHash: string | null;
}

export interface DeploymentPlan {
  readonly schemaVersion: 1;
  readonly capability: DeploymentCapability;
  readonly target: DeploymentTarget;
  readonly artifact: DeploymentArtifact;
  readonly operations: readonly DeploymentOperation[];
  readonly recoveryOperations: readonly RollbackOperation[];
  readonly reviewHash: string;
  readonly review: DeploymentReview;
}

export interface AiDeploymentContext {
  readonly artifactKind: ArtifactKind;
  readonly transport: DeploymentTransport;
  readonly capability: DeploymentCapability;
  readonly plannedOperationTypes: readonly DeploymentOperation['type'][];
  readonly rollbackAvailable: boolean;
}

export class DeploymentValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export function createDeploymentPlan(input: DeploymentRequest): DeploymentPlan;
export function reviewDeploymentPlan(plan: DeploymentPlan, options: { reviewHash: string; at?: string }): DeploymentPlan;
export function approveDeploymentPlan(plan: DeploymentPlan, options: {
  reviewHash: string;
  acknowledgement: 'I_APPROVE_DEPLOYMENT';
  at?: string;
}): DeploymentPlan;
export function verifyDeploymentPlan(plan: DeploymentPlan): boolean;
export function createAiDeploymentContext(plan: DeploymentPlan): AiDeploymentContext;
