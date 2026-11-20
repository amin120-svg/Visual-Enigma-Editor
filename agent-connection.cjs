'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { pathToFileURL } = require('node:url')

const DEFAULTS = Object.freeze({ host: '', port: 7443, domain: '', remoteRoot: 'D:\\Sites\\vee-site', certificateFingerprint: '' })
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_BYTES = 20 * 1024 * 1024
const ASSETS = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'txt', 'xml', 'svg', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'ico', 'woff', 'woff2', 'ttf', 'otf', 'map', 'pdf', 'wasm', 'avif', 'mp3', 'ogg', 'mp4', 'webm', 'webmanifest'])
const PRIVATE_DIRECTORIES = new Set(['.git', 'node_modules', 'private', 'vee-private', 'vendor', '.venv', '__pycache__', 'storage', 'data'])
const SECRET_FILE = /^(?:\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|wp-config\.php|config\.php|credentials(?:\..*)?|secrets?(?:\..*)?|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|.*\.(?:pem|key|p12|pfx|kdbx))$/i
const hash = value => createHash('sha256').update(value).digest('hex')
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)
const inside = (root, candidate) => { const relative = path.relative(root, candidate); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }

async function captureProjectFiles(root, kind) {
  const absolute = path.resolve(root)
  if (await fs.realpath(absolute) !== absolute || !(await fs.lstat(absolute)).isDirectory()) throw new Error('The local project folder changed; reopen it before publishing')
  const files = [], excluded = [], seen = new Set()
  let totalBytes = 0, visited = 0
  async function visit(directory, prefix, depth) {
    if (depth > 20) throw new Error('Project nesting exceeds the release limit')
    const entries = await fs.readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of entries) {
      if (++visited > 10000) throw new Error('Project contains too many release entries')
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = path.join(directory, entry.name)
      const stat = await fs.lstat(full)
      if (entry.name.startsWith('.') || PRIVATE_DIRECTORIES.has(entry.name.toLowerCase()) || SECRET_FILE.test(entry.name)) {
        excluded.push({ path: relative, reason: 'Private, dependency, or credential file' }); continue
      }
      if (stat.isSymbolicLink()) { excluded.push({ path: relative, reason: 'Symbolic link or junction' }); continue }
      const resolved = await fs.realpath(full)
      if (!inside(absolute, resolved) || path.relative(full, resolved) !== '') throw new Error('A release path crosses a filesystem link')
      if (stat.isDirectory()) { await visit(full, relative, depth + 1); continue }
      if (!stat.isFile()) { excluded.push({ path: relative, reason: 'Not a regular file' }); continue }
      const extension = path.extname(entry.name).slice(1).toLowerCase()
      if (!(ASSETS.has(extension) || kind === 'php' && extension === 'php')) {
        excluded.push({ path: relative, reason: 'Unsupported release file type' }); continue
      }
      if (files.length >= 5000 || stat.size > MAX_FILE_BYTES || totalBytes + stat.size > MAX_TOTAL_BYTES) throw new Error('Release exceeds 5000 files, 10 MiB per file, or 20 MiB total')
      const folded = relative.toLowerCase()
      if (seen.has(folded)) throw new Error('Release contains paths that collide on Windows')
      seen.add(folded)
      const handle = await fs.open(full, 'r')
      let bytes
      try {
        const before = await handle.stat()
        if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size) throw new Error('A release file changed while being read')
        const bounded = Buffer.alloc(stat.size + 1)
        let offset = 0
        while (offset < bounded.length) {
          const read = await handle.read(bounded, offset, bounded.length - offset, offset)
          if (!read.bytesRead) break
          offset += read.bytesRead
        }
        bytes = bounded.subarray(0, offset)
        const after = await handle.stat()
        if (bytes.length !== stat.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || await fs.realpath(full) !== resolved) throw new Error('A release file changed while being read')
      } finally { await handle.close() }
      totalBytes += bytes.length
      files.push({ path: relative, contentBase64: bytes.toString('base64') })
    }
  }
  await visit(absolute, '', 0)
  if (!files.length) throw new Error('No supported static or PHP files are available to publish')
  if (await fs.realpath(absolute) !== absolute) throw new Error('The project folder changed during review')
  return { files, excluded, sourceRoot: absolute, contentBytes: totalBytes }
}

function registerAgentConnectionIpc({ registerTrustedHandler, safeStorage, app, getWorkspaceRoot, isOnline, clientFactory } = {}) {
  if (typeof registerTrustedHandler !== 'function' || typeof getWorkspaceRoot !== 'function' || typeof isOnline !== 'function') throw new Error('Trusted desktop Agent dependencies are required')
  const settingsFile = path.join(app.getPath('userData'), 'agent', 'connection.json')
  let busy = false, reviews = new Map(), writing = Promise.resolve()
  const runtime = Promise.all(['agent-client.mjs', 'plan.mjs'].map(file => import(pathToFileURL(path.join(__dirname, 'deploy', file)).href)))
    .then(([client, plan]) => ({ ...client, ...plan }))
  const storageAvailable = () => process.platform === 'win32' && safeStorage.isEncryptionAvailable()
  async function readSettings() {
    try {
      const stat = await fs.lstat(settingsFile)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 24000) throw new Error('invalid')
      const value = JSON.parse(await fs.readFile(settingsFile, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value) || (value.encryptedToken !== null && typeof value.encryptedToken !== 'string')) throw new Error('invalid')
      return value
    } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Saved Windows Agent settings are invalid') }
  }
  function writeSettings(value) {
    const operation = writing.then(async () => {
      await fs.mkdir(path.dirname(settingsFile), { recursive: true, mode: 0o700 })
      const temporary = `${settingsFile}.${randomUUID()}.tmp`
      try { await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, settingsFile) }
      catch { await fs.unlink(temporary).catch(() => {}); throw new Error('Could not save protected Windows Agent settings') }
    })
    writing = operation.catch(() => {})
    return operation
  }
  function publicSettings(settings) {
    return { ...(settings ? Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, settings[key]])) : DEFAULTS), paired: Boolean(settings?.encryptedToken), credentialStorageAvailable: storageAvailable() }
  }
  async function targetFor(settings) {
    if (!settings) throw new Error('Configure and pair the Windows Agent first')
    const { createDeploymentPlan } = await runtime
    const target = { ...Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, settings[key]])), id: `agent-${hash(`${settings.host}:${settings.port}:${settings.certificateFingerprint}`).slice(0, 16)}`, transport: 'vee-agent' }
    return createDeploymentPlan({ target, artifact: { projectId: 'validation', releaseId: 'validation', kind: 'static', sha256: '0'.repeat(64), byteSize: 1 } }).target
  }
  async function client() {
    const tools = await runtime
    const credentialStore = {
      isEnabled: () => isOnline(),
      loadCredential: async targetId => {
        if (!storageAvailable()) throw new Error('Windows credential encryption is unavailable')
        const config = await readSettings()
        if (!config?.encryptedToken || (await targetFor(config)).id !== targetId) return null
        try { return safeStorage.decryptString(Buffer.from(config.encryptedToken, 'base64')) }
        catch { throw new Error('The pairing credential cannot be decrypted; pair again') }
      },
      saveCredential: async (targetId, token) => {
        if (!storageAvailable()) throw new Error('Windows credential encryption is unavailable')
        const config = await readSettings()
        if (!config || (await targetFor(config)).id !== targetId) throw new Error('Agent settings changed during pairing; try again')
        await writeSettings({ ...config, encryptedToken: safeStorage.encryptString(token).toString('base64') })
      },
    }
    const transport = tools.createHttpsAgentTransport(credentialStore)
    return clientFactory ? clientFactory(transport, credentialStore) : tools.createAgentClient({ transport })
  }
  async function network(action) {
    if (!isOnline()) throw new Error('Offline Mode is on. Turn it off to use the Windows Agent')
    if (busy) throw new Error('A Windows Agent operation is already in progress')
    busy = true
    try { return await action(await targetFor(await readSettings()), await client()) }
    catch (error) { throw new Error(`${typeof error.code === 'string' ? `${error.code}: ` : ''}${error.message || 'Windows Agent operation failed'}`) }
    finally { busy = false }
  }
  async function inspect(target, agent, projectId) {
    if (!identifier(projectId)) throw new Error('Choose a registered server project')
    const value = await agent.request(target, { operation: 'inspect-target', projectId })
    if (!value || !['static', 'php'].includes(value.kind) || typeof value.remoteRoot !== 'string' || typeof value.documentRoot !== 'string' || typeof value.healthPath !== 'string' ||
        (value.currentReleaseId !== null && !identifier(value.currentReleaseId)) || (value.previousReleaseId !== null && !identifier(value.previousReleaseId))) throw new Error('The Agent returned invalid project information')
    await targetFor({ ...target, remoteRoot: value.remoteRoot })
    return { projectId, remoteRoot: value.remoteRoot, documentRoot: value.documentRoot, kind: value.kind, currentReleaseId: value.currentReleaseId, previousReleaseId: value.previousReleaseId, healthPath: value.healthPath, liveHealthConfigured: value.liveHealthConfigured === true, recoveryRequired: value.recoveryRequired === true }
  }
  registerTrustedHandler('vee:agent:settings', async () => publicSettings(await readSettings()))
  registerTrustedHandler('vee:agent:save-settings', async input => {
    if (busy) throw new Error('Wait for the current Agent operation to finish')
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !Object.hasOwn(DEFAULTS, key))) throw new Error('Invalid Agent settings')
    const settings = { host: input.host?.trim(), port: input.port, domain: input.domain?.trim(), remoteRoot: input.remoteRoot?.trim(), certificateFingerprint: input.certificateFingerprint?.trim().toLowerCase().replace(/^sha256:/, 'SHA256:') }
    await targetFor(settings)
    const old = await readSettings()
    const unchanged = old && Object.keys(DEFAULTS).every(key => old[key] === settings[key])
    await writeSettings({ ...settings, encryptedToken: unchanged ? old.encryptedToken : null })
    reviews.clear()
    return publicSettings(await readSettings())
  })
  registerTrustedHandler('vee:agent:pair', input => network(async (target, agent) => {
    if (!storageAvailable()) throw new Error('Windows credential encryption is unavailable')
    const controllerName = input?.controllerName?.trim()
    await agent.pair(target, { pairingCode: input?.pairingCode?.trim(), controllerName })
    return { ...publicSettings(await readSettings()), controllerName }
  }))
  registerTrustedHandler('vee:agent:disconnect', async () => {
    if (busy) throw new Error('Wait for the current Agent operation to finish')
    const settings = await readSettings()
    if (settings) await writeSettings({ ...settings, encryptedToken: null })
    reviews.clear()
    return publicSettings(await readSettings())
  })
  registerTrustedHandler('vee:agent:status', () => network(async (target, agent) => {
    const status = await agent.request(target, { operation: 'status' })
    if (!Array.isArray(status.projectIds) || status.projectIds.length > 500 || status.projectIds.some(id => !identifier(id))) throw new Error('The Agent returned invalid registered projects')
    return { connected: true, projectIds: status.projectIds, runtimeKinds: ['static', 'php'].filter(kind => status.runtimeKinds?.includes(kind)), operations: Array.isArray(status.operations) ? status.operations.filter(value => ['status', 'inspect-target', 'stage-release', 'integrity', 'health-check', 'switch-release', 'rollback-release', 'audit'].includes(value)) : [] }
  }))
  registerTrustedHandler('vee:agent:inspect-project', projectId => network((target, agent) => inspect(target, agent, projectId)))
  registerTrustedHandler('vee:agent:prepare-release', input => network(async (target, agent) => {
    if (!input || !identifier(input.localProjectId) || !identifier(input.serverProjectId) || !['static', 'php'].includes(input.kind)) throw new Error('Choose a local project, registered server project, and release kind')
    const remote = await inspect(target, agent, input.serverProjectId)
    if (remote.remoteRoot.toLowerCase().replaceAll('/', '\\') !== target.remoteRoot.toLowerCase() || remote.kind !== input.kind || remote.recoveryRequired || !remote.liveHealthConfigured) throw new Error('Registered project root/kind must match settings and have healthy recovery state plus a live health URL')
    const snapshot = await captureProjectFiles(await getWorkspaceRoot(input.localProjectId), input.kind)
    const tools = await runtime
    const bundle = tools.createReleaseBundle({ projectId: input.serverProjectId, releaseId: `release-${Date.now()}-${randomUUID().slice(0, 8)}`, kind: input.kind, files: snapshot.files })
    const plan = tools.createDeploymentPlan({ target, artifact: bundle.artifact, ...(remote.currentReleaseId ? { previousReleaseId: remote.currentReleaseId } : {}), healthPath: remote.healthPath })
    const reviewId = randomUUID()
    reviews.clear()
    reviews.set(reviewId, { input, snapshot, bundle, plan, expiresAt: Date.now() + 10 * 60 * 1000 })
    return { reviewId, reviewHash: plan.reviewHash, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), localProjectId: input.localProjectId, sourceRoot: snapshot.sourceRoot, serverProjectId: input.serverProjectId, domain: target.domain, host: target.host, port: target.port, remoteRoot: remote.remoteRoot, documentRoot: remote.documentRoot, kind: input.kind, releaseId: bundle.artifact.releaseId, previousReleaseId: remote.currentReleaseId, contentBytes: snapshot.contentBytes, bundleBytes: bundle.artifact.byteSize, sha256: bundle.artifact.sha256, files: bundle.files, excluded: snapshot.excluded, operations: plan.operations.map(item => item.type) }
  }))
  registerTrustedHandler('vee:agent:publish', input => network(async (target, agent) => {
    const review = reviews.get(input?.reviewId)
    if (!review || Date.now() > review.expiresAt || input.reviewHash !== review.plan.reviewHash || input.acknowledgement !== 'I_APPROVE_DEPLOYMENT') throw new Error('Prepare and approve the current release review before publishing')
    reviews.delete(input.reviewId)
    if ((await targetFor(await readSettings())).id !== review.plan.target.id) throw new Error('The server connection changed after review')
    const current = await captureProjectFiles(await getWorkspaceRoot(review.input.localProjectId), review.input.kind)
    if (current.sourceRoot !== review.snapshot.sourceRoot || JSON.stringify(current.files) !== JSON.stringify(review.snapshot.files)) throw new Error('Local files changed after review. Prepare a new release before publishing')
    const tools = await runtime
    const reviewed = tools.reviewDeploymentPlan(review.plan, { reviewHash: input.reviewHash })
    const approved = tools.approveDeploymentPlan(reviewed, { reviewHash: input.reviewHash, acknowledgement: input.acknowledgement })
    return tools.executeDeploymentPlan({ plan: approved, client: agent, bundleBase64: review.bundle.bundleBase64 })
  }))
  registerTrustedHandler('vee:agent:rollback', input => network(async (target, agent) => {
    if (!input || input.confirmation !== 'ROLLBACK RELEASE' || !identifier(input.toReleaseId)) throw new Error('Review the previous release and type ROLLBACK RELEASE')
    const remote = await inspect(target, agent, input.serverProjectId)
    if (remote.previousReleaseId !== input.toReleaseId || remote.recoveryRequired || remote.remoteRoot.toLowerCase().replaceAll('/', '\\') !== target.remoteRoot.toLowerCase()) throw new Error('The previous release or registered destination changed; inspect it again')
    let result
    try { result = await agent.request(target, { operation: 'rollback-release', projectId: input.serverProjectId, payload: { toReleaseId: input.toReleaseId } }) }
    catch (error) { if (error.code === 'SERVER_UNAVAILABLE') throw new Error('DEPLOYMENT_STATE_UNCERTAIN: The rollback response was lost. Reconnect and inspect the server state before retrying'); throw error }
    if (result.ok !== true || result.currentReleaseId !== input.toReleaseId || result.runtimeHealthVerified !== true) throw new Error('DEPLOYMENT_STATE_UNCERTAIN: The Agent did not confirm a healthy rollback. Inspect the server state')
    reviews.clear()
    return { state: 'rolled-back', currentReleaseId: result.currentReleaseId, runtimeHealthVerified: true }
  }))
  return Object.freeze({ defaults: DEFAULTS, clearReviews: () => reviews.clear(), isBusy: () => busy })
}

module.exports = { registerAgentConnectionIpc, captureProjectFiles, DEFAULTS }
