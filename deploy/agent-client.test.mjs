import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createAgentClient, createHttpsAgentTransport, createReleaseBundle, executeDeploymentPlan, verifyAgentCertificate } from './agent-client.mjs';
import { approveDeploymentPlan, createDeploymentPlan, reviewDeploymentPlan } from './plan.mjs';

const target = { id: 'windows-site', host: '192.0.2.10', port: 7443, domain: 'example.com', remoteRoot: 'D:\\Sites\\example', transport: 'vee-agent', certificateFingerprint: `SHA256:${'a'.repeat(64)}` };
const bundle = () => createReleaseBundle({ projectId: 'project-1', releaseId: 'release-2', kind: 'static', files: [{ path: 'index.html', contentBase64: Buffer.from('<h1>VEE</h1>').toString('base64') }] });
const approved = (artifact) => { const plan = createDeploymentPlan({ target, artifact, previousReleaseId: 'release-1' }); return approveDeploymentPlan(reviewDeploymentPlan(plan, { reviewHash: plan.reviewHash }), { reviewHash: plan.reviewHash, acknowledgement: 'I_APPROVE_DEPLOYMENT' }); };

test('release bundles are deterministic and binary data is retained', () => {
  const input = { projectId: 'project-1', releaseId: 'release-2', kind: 'static', files: [{ path: 'assets/logo.png', contentBase64: Buffer.from([0, 255, 32, 10]).toString('base64') }, { path: 'index.html', contentBase64: 'aGk=' }] };
  assert.equal(createReleaseBundle(input).bundleBase64, createReleaseBundle({ ...input, files: [...input.files].reverse() }).bundleBase64);
  const parsed = JSON.parse(Buffer.from(createReleaseBundle(input).bundleBase64, 'base64'));
  assert.deepEqual(Buffer.from(parsed.files[0].contentBase64, 'base64'), Buffer.from([0, 255, 32, 10]));
});

test('Windows unsafe paths, unexpected fields and unsupported runtime content fail locally', () => {
  for (const path of ['../index.html', 'assets/NUL.txt', 'index.html:stream', 'assets\\index.html', '.env', '/index.html']) assert.throws(() => createReleaseBundle({ projectId: 'p', releaseId: 'r', kind: 'static', files: [{ path, contentBase64: 'aGk=' }] }));
  assert.throws(() => createReleaseBundle({ projectId: 'p', releaseId: 'r', kind: 'static', files: [{ path: 'index.php', contentBase64: 'aGk=' }] }));
  assert.throws(() => createReleaseBundle({ projectId: 'p', releaseId: 'r', kind: 'static', files: [{ path: 'index.html', contentBase64: 'aGk=' }, { path: 'INDEX.html', contentBase64: 'aGk=' }] }));
});

test('offline default blocks all network work and cannot require server for local bundles', async () => {
  let credentialReads = 0;
  const transport = createHttpsAgentTransport({ loadCredential: async () => { credentialReads++; return 'unused'; } });
  const client = createAgentClient({ transport });
  await assert.rejects(client.request(target, { operation: 'status' }), { code: 'SERVER_UNAVAILABLE' });
  assert.equal(credentialReads, 0);
  assert.ok(bundle().artifact.sha256);
  await assert.rejects(createAgentClient().request(target, { operation: 'status' }), { code: 'SERVER_UNAVAILABLE' });
});

test('JSON adapter verifies correlated responses and only allows named operations', async () => {
  let calls = 0;
  const client = createAgentClient({ transport: { capabilities: { kind: 'https-json', certificateVerification: 'pinned' }, request: async ({ request }) => { calls++; return { ok: true, requestId: request.requestId, result: { status: 'ok' } }; } } });
  assert.equal((await client.request(target, { operation: 'status' })).status, 'ok');
  await assert.rejects(client.request(target, { operation: 'unlisted' }), { code: 'UNSUPPORTED_OPERATION' });
  await assert.rejects(client.request(target, { operation: 'inspect-target', projectId: 'project-1', payload: { extra: 'instruction' } }), { code: 'INVALID_REQUEST' });
  assert.equal(calls, 1);
  const mismatched = createAgentClient({ transport: { capabilities: { kind: 'https-json', certificateVerification: 'pinned' }, request: async () => ({ ok: true, requestId: 'wrong', result: {} }) } });
  await assert.rejects(mismatched.request(target, { operation: 'status' }), { code: 'INVALID_RESPONSE' });
});

test('certificate pin, host identity and expiry must all pass before authentication', () => {
  const raw = Buffer.from('fixture-certificate');
  const destination = { ...target, certificateFingerprint: `SHA256:${createHash('sha256').update(raw).digest('hex')}` };
  const certificate = { raw, subjectaltname: 'IP Address:192.0.2.10', valid_from: '2026-01-01T00:00:00Z', valid_to: '2027-01-01T00:00:00Z' };
  const now = Date.parse('2026-10-14T00:00:00Z');
  assert.equal(verifyAgentCertificate(destination, certificate, now), true);
  assert.throws(() => verifyAgentCertificate(target, certificate, now), { code: 'CERTIFICATE_MISMATCH' });
  assert.throws(() => verifyAgentCertificate({ ...destination, host: '192.0.2.11' }, certificate, now), { code: 'CERTIFICATE_IDENTITY_INVALID' });
  assert.throws(() => verifyAgentCertificate(destination, { ...certificate, valid_to: '2026-01-02T00:00:00Z' }, now), { code: 'CERTIFICATE_IDENTITY_INVALID' });
});

test('approved publication validates target, staging, integrity and live health in order', async () => {
  const artifactBundle = bundle(), plan = approved(artifactBundle.artifact), operations = [];
  const client = { request: async (_target, request) => {
    operations.push(request.operation);
    if (request.operation === 'inspect-target') return { remoteRoot: target.remoteRoot, kind: 'static', currentReleaseId: 'release-1', liveHealthConfigured: true, healthPath: '/', recoveryRequired: false };
    if (request.operation === 'stage-release') return { releaseId: 'release-2', state: 'staged', sha256: plan.artifact.sha256, byteSize: plan.artifact.byteSize };
    if (request.operation === 'integrity') return { ok: true, sha256: plan.artifact.sha256, byteSize: plan.artifact.byteSize };
    if (request.operation === 'switch-release') return { ok: true, currentReleaseId: 'release-2', previousReleaseId: 'release-1', runtimeHealthVerified: true };
    return { ok: true, releaseId: 'release-2', runtimeHealthVerified: request.payload.phase === 'live' };
  } };
  const result = await executeDeploymentPlan({ plan, client, bundleBase64: artifactBundle.bundleBase64 });
  assert.equal(result.state, 'published');
  assert.deepEqual(operations, ['inspect-target', 'stage-release', 'integrity', 'health-check', 'switch-release', 'health-check']);
  const pending = createDeploymentPlan({ target, artifact: plan.artifact });
  await assert.rejects(executeDeploymentPlan({ plan: pending, client, bundleBase64: artifactBundle.bundleBase64 }), { code: 'APPROVAL_REQUIRED' });
});

test('target drift fails before staging and connection loss during switching is uncertain', async () => {
  const artifactBundle = bundle(), plan = approved(artifactBundle.artifact);
  await assert.rejects(executeDeploymentPlan({ plan, bundleBase64: artifactBundle.bundleBase64, client: { request: async () => ({ remoteRoot: 'D:\\Sites\\different', kind: 'static', currentReleaseId: 'release-1' }) } }), { code: 'TARGET_CHANGED' });
  let calls = 0;
  const client = { request: async (_target, request) => {
    calls++;
    if (request.operation === 'inspect-target') return { remoteRoot: target.remoteRoot, kind: 'static', currentReleaseId: 'release-1', liveHealthConfigured: true, healthPath: '/', recoveryRequired: false };
    if (request.operation === 'stage-release') return { releaseId: 'release-2', state: 'staged', sha256: plan.artifact.sha256, byteSize: plan.artifact.byteSize };
    if (request.operation === 'integrity') return { ok: true, sha256: plan.artifact.sha256, byteSize: plan.artifact.byteSize };
    if (request.operation === 'switch-release') throw Object.assign(new Error('disconnected'), { code: 'SERVER_UNAVAILABLE' });
    return { ok: true, releaseId: 'release-2' };
  } };
  await assert.rejects(executeDeploymentPlan({ plan, client, bundleBase64: artifactBundle.bundleBase64 }), { code: 'DEPLOYMENT_STATE_UNCERTAIN' });
  assert.equal(calls, 5);
});
