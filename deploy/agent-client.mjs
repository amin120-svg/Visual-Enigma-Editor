import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity, connect as tlsConnect } from 'node:tls';
import { createDeploymentPlan, verifyDeploymentPlan } from './plan.mjs';

const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const MAX_CONTENT_BYTES = 20 * 1024 * 1024;
const OPERATIONS = new Set(['status', 'inspect-target', 'stage-release', 'integrity', 'health-check', 'switch-release', 'rollback-release', 'audit']);
const EXTENSIONS = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'webmanifest', 'txt', 'xml', 'svg', 'png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'ico', 'woff', 'woff2', 'ttf', 'otf', 'wasm', 'mp3', 'ogg', 'mp4', 'webm', 'map', 'pdf']);

export class AgentClientError extends Error {
  constructor(code, message) { super(message); this.name = 'AgentClientError'; this.code = code; }
}

function fail(code, message) { throw new AgentClientError(code, message); }
function hash(data) { return createHash('sha256').update(data).digest('hex'); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fields(value, allowed, required = []) {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) fail('INVALID_REQUEST', 'Unexpected or missing agent fields.');
}
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) fail('INVALID_IDENTIFIER', 'A safe identifier is required.');
  return value;
}
function base64(value, limit) {
  if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('INVALID_BUNDLE', 'Canonical bounded Base64 is required.');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length > limit || decoded.toString('base64') !== value) fail('INVALID_BUNDLE', 'Canonical bounded Base64 is required.');
  return decoded;
}
function filePath(value) {
  if (typeof value !== 'string' || !value || value.length > 180 || value.normalize('NFC') !== value || value.split('/').some((part) => !part || part.length > 100 || part.startsWith('.') || /[. ]$/.test(part) || /[<>:"\\|?*\x00-\x1f]/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) fail('UNSAFE_FILE_PATH', 'A file path is unsafe on Windows.');
  return value;
}
function checkedTarget(target) {
  const plan = createDeploymentPlan({ target, artifact: { projectId: 'validation', releaseId: 'validation', kind: 'static', sha256: '0'.repeat(64), byteSize: 1 } });
  if (plan.target.transport !== 'vee-agent') fail('UNSUPPORTED_TRANSPORT', 'The Windows agent uses pinned HTTPS.');
  return plan.target;
}

export function createReleaseBundle(input) {
  fields(input, ['projectId', 'releaseId', 'kind', 'files'], ['projectId', 'releaseId', 'kind', 'files']);
  const projectId = id(input.projectId), releaseId = id(input.releaseId);
  if (!['static', 'php'].includes(input.kind) || !Array.isArray(input.files) || !input.files.length || input.files.length > 5000) fail('UNSUPPORTED_ARTIFACT', 'Provide 1 to 5000 static or PHP project files.');
  const seen = new Set(); let total = 0;
  const files = input.files.map((item) => {
    fields(item, ['path', 'contentBase64'], ['path', 'contentBase64']);
    const path = filePath(item.path), lower = path.toLowerCase();
    const extension = path.split('.').at(-1).toLowerCase();
    if (seen.has(lower) || lower === 'vee-release.json' || !(EXTENSIONS.has(extension) || input.kind === 'php' && extension === 'php')) fail('UNSAFE_FILE_PATH', 'Duplicate, agent-reserved or unsupported artifact file.');
    seen.add(lower);
    const content = base64(item.contentBase64, 10 * 1024 * 1024);
    total += content.length;
    if (total > MAX_CONTENT_BYTES) fail('BUNDLE_TOO_LARGE', 'Decoded artifact contents exceed 20 MiB.');
    return { path, contentBase64: item.contentBase64, sha256: hash(content), byteSize: content.length };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const raw = Buffer.from(JSON.stringify({ schemaVersion: 1, projectId, releaseId, kind: input.kind, files }), 'utf8');
  if (raw.length > MAX_BUNDLE_BYTES) fail('BUNDLE_TOO_LARGE', 'The canonical artifact bundle exceeds 32 MiB.');
  return Object.freeze({ artifact: Object.freeze({ projectId, releaseId, kind: input.kind, sha256: hash(raw), byteSize: raw.length }), bundleBase64: raw.toString('base64'), files: Object.freeze(files.map(({ path, sha256, byteSize }) => Object.freeze({ path, sha256, byteSize }))) });
}

function validateOperation(input) {
  fields(input, ['operation', 'projectId', 'payload'], ['operation']);
  if (!OPERATIONS.has(input.operation)) fail('UNSUPPORTED_OPERATION', 'Only named deployment operations are supported.');
  const payload = input.payload ?? {};
  if (input.operation === 'status') {
    if (input.projectId !== undefined) fail('INVALID_REQUEST', 'Status does not take a project ID.');
    fields(payload, []);
  } else {
    id(input.projectId);
    if (['inspect-target'].includes(input.operation)) fields(payload, []);
    else if (input.operation === 'audit') {
      fields(payload, ['limit']);
      if (payload.limit !== undefined && (!Number.isInteger(payload.limit) || payload.limit < 1 || payload.limit > 200)) fail('INVALID_REQUEST', 'Audit limit must be between 1 and 200.');
    } else if (['integrity', 'switch-release', 'rollback-release'].includes(input.operation)) {
      const key = input.operation === 'rollback-release' ? 'toReleaseId' : 'releaseId';
      fields(payload, [key], [key]); id(payload[key]);
    } else if (input.operation === 'health-check') {
      fields(payload, ['phase', 'releaseId'], ['phase']);
      if (!['staged', 'live'].includes(payload.phase)) fail('INVALID_REQUEST', 'Invalid health phase.');
      if (payload.phase === 'staged') id(payload.releaseId);
      else if (payload.releaseId !== undefined) fail('INVALID_REQUEST', 'Live health uses the current release.');
    } else {
      fields(payload, ['releaseId', 'kind', 'sha256', 'byteSize', 'bundleBase64'], ['releaseId', 'kind', 'sha256', 'byteSize', 'bundleBase64']);
      id(payload.releaseId);
      const raw = base64(payload.bundleBase64, MAX_BUNDLE_BYTES);
      if (!['static', 'php'].includes(payload.kind) || !Number.isSafeInteger(payload.byteSize) || raw.length !== payload.byteSize || hash(raw) !== payload.sha256) fail('INTEGRITY_FAILED', 'The artifact does not match its size and SHA-256.');
    }
  }
  return { protocolVersion: 1, requestId: randomUUID(), operation: input.operation, ...(input.projectId === undefined ? {} : { projectId: input.projectId }), payload: structuredClone(payload) };
}

export function createAgentClient({ transport } = {}) {
  function requireTransport() {
    if (!transport || transport.capabilities?.kind !== 'https-json' || transport.capabilities?.certificateVerification !== 'pinned' || typeof transport.request !== 'function') fail('SERVER_UNAVAILABLE', 'The server connection is unavailable. Local editing remains available.');
  }
  return Object.freeze({
    async request(target, input) {
      const destination = checkedTarget(target), request = validateOperation(input);
      requireTransport();
      const response = await transport.request({ target: destination, request });
      return unwrap(response, request.requestId);
    },
    async pair(target, input) {
      const destination = checkedTarget(target);
      fields(input, ['pairingCode', 'controllerName'], ['pairingCode', 'controllerName']);
      if (typeof input.pairingCode !== 'string' || input.pairingCode.length < 20 || input.pairingCode.length > 200 || typeof input.controllerName !== 'string' || !input.controllerName.length || input.controllerName.length > 80 || /[\x00-\x1f]/.test(input.controllerName)) fail('INVALID_PAIRING', 'Enter the code shown by the agent and a desktop name.');
      requireTransport();
      if (typeof transport.pair !== 'function') fail('SERVER_UNAVAILABLE', 'Secure pairing is unavailable.');
      return transport.pair({ target: destination, pairing: structuredClone(input) });
    },
  });
}

function unwrap(response, requestId) {
  fields(response, ['ok', 'requestId', 'result', 'error'], ['ok', 'requestId']);
  if (response.requestId !== requestId || typeof response.ok !== 'boolean') fail('INVALID_RESPONSE', 'The agent response does not match this request.');
  if (!response.ok) {
    if (!record(response.error) || typeof response.error.code !== 'string' || !/^[A-Z_]{1,80}$/.test(response.error.code)) fail('INVALID_RESPONSE', 'The agent returned an invalid error.');
    throw new AgentClientError(response.error.code, typeof response.error.message === 'string' && response.error.message.length < 500 ? response.error.message : 'The agent refused this operation.');
  }
  if (!record(response.result)) fail('INVALID_RESPONSE', 'The agent result must be an object.');
  return response.result;
}

export function verifyAgentCertificate(target, certificate, now = Date.now()) {
  if (!certificate.raw || !/^SHA256:[a-f0-9]{64}$/.test(target.certificateFingerprint)) fail('CERTIFICATE_MISMATCH', 'The agent did not provide a valid pinned certificate.');
  const actual = createHash('sha256').update(certificate.raw).digest();
  const expected = Buffer.from(target.certificateFingerprint.slice(7), 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('CERTIFICATE_MISMATCH', 'The certificate fingerprint differs from the trusted agent.');
  const identityError = checkServerIdentity(target.host, certificate);
  const from = Date.parse(certificate.valid_from), to = Date.parse(certificate.valid_to);
  if (identityError || !Number.isFinite(from) || !Number.isFinite(to) || from > now || to < now) fail('CERTIFICATE_IDENTITY_INVALID', 'The pinned certificate is expired or does not identify this host.');
  return true;
}

class PinnedAgent extends HttpsAgent {
  constructor(target) { super({ keepAlive: false, maxSockets: 1 }); this.target = target; }
  createConnection(_options, callback) {
    const target = this.target;
    // No HTTP bytes or authorization headers are sent until this callback verifies the peer.
    const socket = tlsConnect({ host: target.host, port: target.port, servername: isIP(target.host) ? undefined : target.host, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    let finished = false;
    const finish = (error) => { if (finished) return; finished = true; if (error) { socket.destroy(); callback(error); } else callback(null, socket); };
    socket.setTimeout(10_000, () => finish(new AgentClientError('SERVER_UNAVAILABLE', 'The server connection timed out. Local editing remains available.')));
    socket.once('secureConnect', () => {
      try {
        const certificate = socket.getPeerCertificate();
        verifyAgentCertificate(target, certificate);
        finish();
      } catch (error) { finish(error); }
    });
    socket.once('error', (error) => finish(error instanceof AgentClientError ? error : new AgentClientError('SERVER_UNAVAILABLE', 'The server connection is unavailable. Local editing remains available.')));
    return undefined;
  }
}

function sendHttps(target, route, data, token) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  const agent = new PinnedAgent(target);
  return new Promise((resolve, reject) => {
    const request = httpsRequest({ host: target.host, port: target.port, path: route, method: 'POST', agent, headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) } }, (response) => {
      const chunks = []; let size = 0;
      response.on('data', (chunk) => { size += chunk.length; if (size > 256 * 1024) response.destroy(new AgentClientError('INVALID_RESPONSE', 'Agent response exceeded its limit.')); else chunks.push(chunk); });
      response.on('end', () => {
        agent.destroy();
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new AgentClientError('INVALID_RESPONSE', 'The agent returned invalid JSON.')); }
      });
      response.on('error', (error) => { agent.destroy(); reject(error instanceof AgentClientError ? error : new AgentClientError('SERVER_UNAVAILABLE', 'The server connection ended before completion.')); });
    });
    request.setTimeout(15_000, () => request.destroy(new AgentClientError('SERVER_UNAVAILABLE', 'The server connection timed out.')));
    request.on('error', (error) => { agent.destroy(); reject(error instanceof AgentClientError ? error : new AgentClientError('SERVER_UNAVAILABLE', 'The server connection is unavailable. Local editing remains available.')); });
    request.end(body);
  });
}

export function createHttpsAgentTransport({ loadCredential, saveCredential, isEnabled = () => false } = {}) {
  async function enabled() { if (!await isEnabled()) fail('SERVER_UNAVAILABLE', 'The server is disconnected. Local editing remains available.'); }
  return Object.freeze({
    capabilities: Object.freeze({ kind: 'https-json', certificateVerification: 'pinned' }),
    async request({ target, request }) {
      target = checkedTarget(target);
      await enabled();
      if (typeof loadCredential !== 'function') fail('PAIRING_REQUIRED', 'Secure credential storage is unavailable.');
      const token = await loadCredential(target.id);
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) fail('PAIRING_REQUIRED', 'Pair this desktop with the Windows agent.');
      return sendHttps(target, '/v1/rpc', request, token);
    },
    async pair({ target, pairing }) {
      target = checkedTarget(target);
      await enabled();
      if (typeof saveCredential !== 'function') fail('PAIRING_REQUIRED', 'Configure encrypted desktop credential storage before pairing.');
      const result = unwrap(await sendHttps(target, '/v1/pair', pairing), null);
      if (typeof result.token !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(result.token) || result.protocolVersion !== 1 || result.certificateFingerprint !== target.certificateFingerprint) fail('INVALID_RESPONSE', 'The agent pairing response is invalid.');
      await saveCredential(target.id, result.token);
      return Object.freeze({ paired: true, controllerName: result.controllerName, protocolVersion: 1, certificateFingerprint: result.certificateFingerprint });
    },
  });
}

export async function executeDeploymentPlan({ plan, client, bundleBase64 }) {
  if (!verifyDeploymentPlan(plan)) fail('APPROVAL_REQUIRED', 'Review and approve this exact publication plan before execution.');
  if (plan.target.transport !== 'vee-agent' || !client || typeof client.request !== 'function') fail('SERVER_UNAVAILABLE', 'A paired Windows agent is required.');
  const raw = base64(bundleBase64, MAX_BUNDLE_BYTES);
  if (raw.length !== plan.artifact.byteSize || hash(raw) !== plan.artifact.sha256) fail('INTEGRITY_FAILED', 'Artifact contents changed after review.');
  const bundle = JSON.parse(raw.toString('utf8'));
  if (bundle.projectId !== plan.artifact.projectId || bundle.releaseId !== plan.artifact.releaseId || bundle.kind !== plan.artifact.kind) fail('INTEGRITY_FAILED', 'Artifact metadata differs from the reviewed plan.');
  const projectId = plan.artifact.projectId, releaseId = plan.artifact.releaseId;
  const inspect = await client.request(plan.target, { operation: 'inspect-target', projectId });
  const plannedPrevious = plan.recoveryOperations[0]?.toReleaseId ?? null;
  if (typeof inspect.remoteRoot !== 'string' || inspect.remoteRoot.replaceAll('/', '\\').toLowerCase() !== plan.target.remoteRoot.toLowerCase() || inspect.kind !== plan.artifact.kind || inspect.currentReleaseId !== plannedPrevious || inspect.recoveryRequired) fail('TARGET_CHANGED', 'Agent project configuration or current release differs from the reviewed plan.');
  if (!inspect.liveHealthConfigured) fail('HEALTH_NOT_CONFIGURED', 'Configure a local live health URL in the agent GUI before publishing.');
  const plannedHealth = plan.operations.find((operation) => operation.type === 'health-check')?.path;
  if (inspect.healthPath !== plannedHealth) fail('HEALTH_POLICY_CHANGED', 'The agent health path differs from the reviewed plan.');
  const receipt = await client.request(plan.target, { operation: 'stage-release', projectId, payload: { releaseId, kind: plan.artifact.kind, sha256: plan.artifact.sha256, byteSize: plan.artifact.byteSize, bundleBase64 } });
  if (receipt.releaseId !== releaseId || receipt.state !== 'staged' || receipt.sha256 !== plan.artifact.sha256 || receipt.byteSize !== plan.artifact.byteSize) fail('INVALID_RESPONSE', 'The agent staging receipt does not match the artifact.');
  const integrity = await client.request(plan.target, { operation: 'integrity', projectId, payload: { releaseId } });
  if (integrity.ok !== true || integrity.sha256 !== plan.artifact.sha256 || integrity.byteSize !== plan.artifact.byteSize) fail('INTEGRITY_FAILED', 'The staged artifact failed its server integrity check.');
  const staged = await client.request(plan.target, { operation: 'health-check', projectId, payload: { phase: 'staged', releaseId } });
  if (staged.ok !== true || staged.releaseId !== releaseId) fail('STAGED_HEALTH_FAILED', 'The staged release failed its configured file checks.');
  let switched;
  try {
    switched = await client.request(plan.target, { operation: 'switch-release', projectId, payload: { releaseId } });
  } catch (error) {
    if (error?.code === 'SERVER_UNAVAILABLE') fail('DEPLOYMENT_STATE_UNCERTAIN', 'The connection ended during publication. Inspect the agent state after reconnecting before retrying.');
    throw error;
  }
  if (switched.ok !== true || switched.currentReleaseId !== releaseId || switched.runtimeHealthVerified !== true) fail('DEPLOYMENT_STATE_UNCERTAIN', 'The agent did not confirm a healthy current release. Inspect its state before retrying.');
  let live;
  try {
    live = await client.request(plan.target, { operation: 'health-check', projectId, payload: { phase: 'live' } });
  } catch (error) {
    if (error?.code === 'SERVER_UNAVAILABLE') fail('DEPLOYMENT_STATE_UNCERTAIN', 'Publication was confirmed, but the final health response was lost. Reconnect and inspect the agent state.');
    throw error;
  }
  if (live.ok !== true || live.runtimeHealthVerified !== true || live.releaseId !== releaseId) {
    if (plannedPrevious !== null) {
      try {
        const recovered = await client.request(plan.target, { operation: 'rollback-release', projectId, payload: { toReleaseId: plannedPrevious } });
        if (recovered.ok === true && recovered.currentReleaseId === plannedPrevious) fail('LIVE_HEALTH_FAILED', 'The final health check failed; the previous release was restored.');
      } catch (error) {
        if (error?.code === 'LIVE_HEALTH_FAILED' && error.message.includes('previous release was restored')) throw error;
      }
    }
    fail('DEPLOYMENT_STATE_UNCERTAIN', 'The final health check failed. Inspect the server state and recovery record in the agent GUI.');
  }
  return Object.freeze({ state: 'published', currentReleaseId: releaseId, previousReleaseId: switched.previousReleaseId ?? null, runtimeHealthVerified: true });
}
