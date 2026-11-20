import assert from 'node:assert/strict';
import test from 'node:test';
import {
  approveDeploymentPlan,
  createAiDeploymentContext,
  createDeploymentPlan,
  DeploymentValidationError,
  reviewDeploymentPlan,
  verifyDeploymentPlan,
} from './plan.mjs';

function request(transport = 'vee-agent', kind = 'php') {
  return {
    target: {
      id: 'target-1',
      host: '203.0.113.10',
      port: transport === 'vee-agent' ? 7443 : 22,
      domain: 'example.com',
      remoteRoot: transport === 'vee-agent' ? 'D:\\Sites\\project-1' : '/home/siteuser/public_html',
      transport,
      ...(transport === 'vee-agent' ? { certificateFingerprint: `SHA256:${'a'.repeat(64)}` } : { hostKeyFingerprint: `SHA256:${'A'.repeat(43)}` }),
    },
    artifact: {
      projectId: 'project-1',
      releaseId: 'release-2',
      kind,
      sha256: 'a'.repeat(64),
      byteSize: 4096,
    },
    ...(transport === 'vee-agent' ? { previousReleaseId: 'release-1' } : {}),
  };
}

function rejectsCode(action, code) {
  assert.throws(action, (error) => error instanceof DeploymentValidationError && error.code === code);
}

test('agent plan has typed release and rollback operations', () => {
  const plan = createDeploymentPlan(request());
  assert.equal(plan.capability, 'release-managed');
  assert.deepEqual(plan.operations.map((operation) => operation.type), [
    'inspect-target', 'stage-release', 'health-check', 'switch-release', 'health-check',
  ]);
  assert.deepEqual(plan.recoveryOperations.map((operation) => operation.type), ['rollback-release']);
  assert.equal(verifyDeploymentPlan(plan), false);
});

test('SFTP is transfer-only and cannot promise activation or rollback', () => {
  const plan = createDeploymentPlan(request('sftp', 'static'));
  assert.equal(plan.capability, 'transfer-only');
  assert.deepEqual(plan.operations.map((operation) => operation.type), ['inspect-target', 'stage-release']);
  assert.deepEqual(plan.recoveryOperations, []);
  rejectsCode(() => createDeploymentPlan(request('sftp', 'node')), 'UNSUPPORTED_SFTP_RUNTIME');
});

test('path traversal, sensitive roots and URL-shaped domains are rejected', () => {
  const traversal = request();
  traversal.target.remoteRoot = 'D:\\Sites\\..\\other';
  rejectsCode(() => createDeploymentPlan(traversal), 'INVALID_REMOTE_ROOT');

  const broad = request();
  broad.target.remoteRoot = 'D:\\Sites';
  rejectsCode(() => createDeploymentPlan(broad), 'INVALID_REMOTE_ROOT');

  const sensitive = request();
  sensitive.target.remoteRoot = 'C:\\Windows\\site';
  rejectsCode(() => createDeploymentPlan(sensitive), 'INVALID_REMOTE_ROOT');

  const url = request();
  url.target.domain = 'https://example.com/admin';
  rejectsCode(() => createDeploymentPlan(url), 'INVALID_DOMAIN');

  const health = request();
  health.healthPath = '/health/../private';
  rejectsCode(() => createDeploymentPlan(health), 'INVALID_HEALTH_PATH');
});

test('unexpected input fields cannot carry executable instructions or secrets', () => {
  const unknownTopLevel = request();
  unknownTopLevel.unexpectedField = 'not part of the protocol';
  rejectsCode(() => createDeploymentPlan(unknownTopLevel), 'UNKNOWN_FIELD');

  const unknownTarget = request();
  unknownTarget.target.unexpectedField = 'not part of the protocol';
  rejectsCode(() => createDeploymentPlan(unknownTarget), 'UNKNOWN_FIELD');
});

test('review and explicit approval bind to the exact plan hash', () => {
  const plan = createDeploymentPlan(request());
  rejectsCode(() => approveDeploymentPlan(plan, {
    reviewHash: plan.reviewHash,
    acknowledgement: 'I_APPROVE_DEPLOYMENT',
  }), 'APPROVAL_REQUIRED');
  rejectsCode(() => reviewDeploymentPlan(plan, { reviewHash: 'wrong' }), 'REVIEW_REQUIRED');
  const reviewed = reviewDeploymentPlan(plan, { reviewHash: plan.reviewHash, at: '2026-01-01T00:00:00.000Z' });
  rejectsCode(() => approveDeploymentPlan(reviewed, {
    reviewHash: plan.reviewHash,
    acknowledgement: 'I_APPROVE_DEPLOYMENT',
    at: '2025-12-31T23:59:59.000Z',
  }), 'INVALID_TIMESTAMP');
  const approved = approveDeploymentPlan(reviewed, {
    reviewHash: plan.reviewHash,
    acknowledgement: 'I_APPROVE_DEPLOYMENT',
    at: '2026-01-01T00:01:00.000Z',
  });
  assert.equal(verifyDeploymentPlan(approved), true);

  const altered = structuredClone(approved);
  altered.target.remoteRoot = 'D:\\Sites\\other';
  assert.equal(verifyDeploymentPlan(altered), false);
});

test('AI planning context contains only approved metadata fields', () => {
  const plan = createDeploymentPlan(request());
  const context = createAiDeploymentContext(plan);
  assert.deepEqual(Object.keys(context), [
    'artifactKind', 'transport', 'capability', 'plannedOperationTypes', 'rollbackAvailable',
  ]);
  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes(plan.target.host), false);
  assert.equal(serialized.includes(plan.target.domain), false);
  assert.equal(serialized.includes(plan.target.remoteRoot), false);
  assert.equal(serialized.includes(plan.target.certificateFingerprint), false);
});

test('Windows agent plans reject unsupported runtimes and mismatched identity pins', () => {
  rejectsCode(() => createDeploymentPlan(request('vee-agent', 'node')), 'UNSUPPORTED_AGENT_RUNTIME');
  const wrongIdentity = request();
  wrongIdentity.target.hostKeyFingerprint = `SHA256:${'A'.repeat(43)}`;
  rejectsCode(() => createDeploymentPlan(wrongIdentity), 'INVALID_TRANSPORT_IDENTITY');
});
