import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { win32 } from 'node:path';

const ARTIFACT_KINDS = new Set(['static', 'php', 'node', 'python']);
const TRANSPORTS = new Set(['sftp', 'vee-agent']);
const RESERVED_ROOTS = new Set([
  '/', '/home', '/root', '/etc', '/var', '/var/www', '/srv', '/opt',
  '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/dev', '/proc',
  '/sys', '/tmp',
]);
const REVIEW_ACKNOWLEDGEMENT = 'I_APPROVE_DEPLOYMENT';

export class DeploymentValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeploymentValidationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DeploymentValidationError(code, message);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, label) {
  if (!isRecord(value)) fail('INVALID_SHAPE', `${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('UNKNOWN_FIELD', `${label} contains an unsupported field.`);
  }
}

function nonEmptyIdentifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) {
    fail('INVALID_IDENTIFIER', `${label} must be a safe identifier.`);
  }
  return value;
}

function publicDomain(value) {
  if (typeof value !== 'string' || value.length > 253 || value !== value.toLowerCase()) {
    fail('INVALID_DOMAIN', 'Domain must be a lowercase DNS name without a scheme or path.');
  }
  const labels = value.split('.');
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    fail('INVALID_DOMAIN', 'Domain must be a valid DNS name.');
  }
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(labels.at(-1))) {
    fail('INVALID_DOMAIN', 'Domain must have a valid public suffix label.');
  }
  return value;
}

function serverHost(value) {
  if (typeof value !== 'string' || value.length > 253 || value.includes('://') || /[\s\\/@?#%]/.test(value)) {
    fail('INVALID_HOST', 'Server host must be a DNS name or IP address.');
  }
  if (isIP(value)) return value;
  return publicDomain(value);
}

function remoteRoot(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.endsWith('/') || value.includes('//')) {
    fail('INVALID_REMOTE_ROOT', 'Remote root must be a specific absolute POSIX path.');
  }
  const segments = value.slice(1).split('/');
  if (segments.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(part))) {
    fail('INVALID_REMOTE_ROOT', 'Remote root contains an unsafe path segment.');
  }
  if (RESERVED_ROOTS.has(value.toLowerCase())) {
    fail('INVALID_REMOTE_ROOT', 'Remote root is too broad or sensitive.');
  }
  const first = segments[0].toLowerCase();
  const siteDirectory = (/^home\d*$/.test(first) && segments.length >= 3) ||
    (first === 'srv' && segments.length >= 2) ||
    (first === 'var' && segments[1]?.toLowerCase() === 'www' && segments.length >= 3) ||
    (first === 'sites' && segments.length >= 2) ||
    // A chrooted SFTP account may present its document root as /public_html.
    first === 'public_html' || first === 'www';
  if (!siteDirectory) {
    fail('INVALID_REMOTE_ROOT', 'Remote root must identify a site directory under an allowed layout.');
  }
  return value;
}

function healthPath(value) {
  if (typeof value !== 'string' || !/^\/(?:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)?$/.test(value) || value.split('/').some((segment) => segment === '.' || segment === '..')) {
    fail('INVALID_HEALTH_PATH', 'Health path must be a simple relative URL path.');
  }
  return value;
}

function windowsRoot(value) {
  if (typeof value !== 'string' || !/^[A-Za-z]:[\\/]/.test(value) || value.length > 140 || value.endsWith('\\') || value.endsWith('/')) {
    fail('INVALID_REMOTE_ROOT', 'Choose a specific local Windows project folder.');
  }
  const parts = value.slice(3).split(/[\\/]/);
  if (parts.length < 2 || parts.some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith(' ') || /[<>:"|?*\x00-\x1f]/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) {
    fail('INVALID_REMOTE_ROOT', 'Remote folder contains an unsafe Windows path segment.');
  }
  if (/^(?:windows|users|program files(?: \(x86\))?|programdata)$/i.test(parts[0])) {
    fail('INVALID_REMOTE_ROOT', 'Choose a project folder outside system and profile folders.');
  }
  return win32.normalize(value[0].toUpperCase() + value.slice(1));
}

function certificateFingerprint(value) {
  if (typeof value !== 'string' || !/^SHA256:[a-f0-9]{64}$/.test(value)) {
    fail('INVALID_CERTIFICATE_PIN', 'Verify and pin the agent certificate SHA-256 fingerprint.');
  }
  return value;
}

function fingerprint(value) {
  if (typeof value !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(value)) {
    fail('INVALID_HOST_KEY', 'A pinned SHA256 SSH host-key fingerprint is required.');
  }
  return value;
}

function validateTarget(input) {
  exactKeys(input, ['id', 'host', 'port', 'domain', 'remoteRoot', 'transport', 'hostKeyFingerprint', 'certificateFingerprint'], 'Target');
  if (!TRANSPORTS.has(input.transport)) fail('INVALID_TRANSPORT', 'Unsupported deployment transport.');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    fail('INVALID_PORT', 'Port must be between 1 and 65535.');
  }
  if (input.transport === 'vee-agent' && input.hostKeyFingerprint !== undefined || input.transport === 'sftp' && input.certificateFingerprint !== undefined) {
    fail('INVALID_TRANSPORT_IDENTITY', 'Use the identity pin for the selected transport.');
  }
  return {
    id: nonEmptyIdentifier(input.id, 'Target ID'),
    host: serverHost(input.host),
    port: input.port,
    domain: publicDomain(input.domain),
    remoteRoot: input.transport === 'vee-agent' ? windowsRoot(input.remoteRoot) : remoteRoot(input.remoteRoot),
    transport: input.transport,
    ...(input.transport === 'vee-agent'
      ? { certificateFingerprint: certificateFingerprint(input.certificateFingerprint) }
      : { hostKeyFingerprint: fingerprint(input.hostKeyFingerprint) }),
  };
}

function validateArtifact(input) {
  exactKeys(input, ['projectId', 'releaseId', 'kind', 'sha256', 'byteSize'], 'Artifact');
  if (!ARTIFACT_KINDS.has(input.kind)) fail('INVALID_ARTIFACT_KIND', 'Unsupported artifact kind.');
  if (typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)) {
    fail('INVALID_ARTIFACT_HASH', 'Artifact SHA-256 must be 64 lowercase hexadecimal characters.');
  }
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0) {
    fail('INVALID_ARTIFACT_SIZE', 'Artifact byte size must be a positive safe integer.');
  }
  return {
    projectId: nonEmptyIdentifier(input.projectId, 'Project ID'),
    releaseId: nonEmptyIdentifier(input.releaseId, 'Release ID'),
    kind: input.kind,
    sha256: input.sha256,
    byteSize: input.byteSize,
  };
}

function planCore(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    capability: plan.capability,
    target: plan.target,
    artifact: plan.artifact,
    operations: plan.operations,
    recoveryOperations: plan.recoveryOperations,
  };
}

function hashCore(core) {
  return createHash('sha256').update(JSON.stringify(core), 'utf8').digest('hex');
}

function frozen(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function assertIntegrity(plan) {
  if (!isRecord(plan) || typeof plan.reviewHash !== 'string' || hashCore(planCore(plan)) !== plan.reviewHash) {
    fail('PLAN_CHANGED', 'Deployment plan changed after creation; create a new plan.');
  }
}

function timestamp(value) {
  const result = value ?? new Date().toISOString();
  if (typeof result !== 'string' || Number.isNaN(Date.parse(result)) ||
      new Date(result).toISOString() !== result) {
    fail('INVALID_TIMESTAMP', 'Review timestamp must be a canonical UTC date-time.');
  }
  return result;
}

export function createDeploymentPlan(input) {
  exactKeys(input, ['target', 'artifact', 'previousReleaseId', 'healthPath'], 'Deployment request');
  const target = validateTarget(input.target);
  const artifact = validateArtifact(input.artifact);
  const previousReleaseId = input.previousReleaseId === undefined
    ? null : nonEmptyIdentifier(input.previousReleaseId, 'Previous release ID');
  if (previousReleaseId === artifact.releaseId) {
    fail('INVALID_PREVIOUS_RELEASE', 'Previous and new release IDs must differ.');
  }
  const checkPath = healthPath(input.healthPath ?? '/');
  const agent = target.transport === 'vee-agent';
  if (agent && !['static', 'php'].includes(artifact.kind)) {
    fail('UNSUPPORTED_AGENT_RUNTIME', 'The Windows agent currently publishes static and PHP artifacts only.');
  }
  if (!agent && !['static', 'php'].includes(artifact.kind)) {
    fail('UNSUPPORTED_SFTP_RUNTIME', 'SFTP-only mode cannot start Node or Python applications.');
  }
  if (!agent && previousReleaseId !== null) {
    fail('UNSUPPORTED_SFTP_ROLLBACK', 'SFTP-only mode cannot guarantee release rollback.');
  }
  const operations = [
    { type: 'inspect-target', targetId: target.id },
    { type: 'stage-release', projectId: artifact.projectId, releaseId: artifact.releaseId, sha256: artifact.sha256, byteSize: artifact.byteSize },
  ];
  if (agent) {
    operations.push(
      { type: 'health-check', phase: 'staged', path: checkPath },
      { type: 'switch-release', projectId: artifact.projectId, releaseId: artifact.releaseId },
      { type: 'health-check', phase: 'live', path: checkPath },
    );
  }
  const recoveryOperations = agent && previousReleaseId !== null
    ? [{ type: 'rollback-release', projectId: artifact.projectId, toReleaseId: previousReleaseId }]
    : [];
  const core = {
    schemaVersion: 1,
    capability: agent ? 'release-managed' : 'transfer-only',
    target,
    artifact,
    operations,
    recoveryOperations,
  };
  return frozen({
    ...core,
    reviewHash: hashCore(core),
    review: { state: 'pending', reviewedAt: null, approvedAt: null, reviewHash: null },
  });
}

export function reviewDeploymentPlan(plan, { reviewHash, at } = {}) {
  assertIntegrity(plan);
  if (plan.review?.state !== 'pending' || reviewHash !== plan.reviewHash) {
    fail('REVIEW_REQUIRED', 'Review the current deployment plan before continuing.');
  }
  return frozen({
    ...plan,
    review: { state: 'reviewed', reviewedAt: timestamp(at), approvedAt: null, reviewHash: plan.reviewHash },
  });
}

export function approveDeploymentPlan(plan, { reviewHash, acknowledgement, at } = {}) {
  assertIntegrity(plan);
  if (plan.review?.state !== 'reviewed' || plan.review.reviewHash !== plan.reviewHash ||
      reviewHash !== plan.reviewHash || acknowledgement !== REVIEW_ACKNOWLEDGEMENT) {
    fail('APPROVAL_REQUIRED', 'Explicit approval of the reviewed deployment plan is required.');
  }
  const approvedAt = timestamp(at);
  if (Date.parse(approvedAt) < Date.parse(plan.review.reviewedAt)) {
    fail('INVALID_TIMESTAMP', 'Approval cannot precede review.');
  }
  return frozen({
    ...plan,
    review: { ...plan.review, state: 'approved', approvedAt },
  });
}

export function verifyDeploymentPlan(plan) {
  try {
    assertIntegrity(plan);
    return plan.review?.state === 'approved' &&
      plan.review.reviewHash === plan.reviewHash &&
      typeof plan.review.reviewedAt === 'string' &&
      typeof plan.review.approvedAt === 'string';
  } catch {
    return false;
  }
}

// Deliberately omits host, domain, remote path, source, credential material and user text.
export function createAiDeploymentContext(plan) {
  assertIntegrity(plan);
  return frozen({
    artifactKind: plan.artifact.kind,
    transport: plan.target.transport,
    capability: plan.capability,
    plannedOperationTypes: plan.operations.map((operation) => operation.type),
    rollbackAvailable: plan.recoveryOperations.length > 0,
  });
}
