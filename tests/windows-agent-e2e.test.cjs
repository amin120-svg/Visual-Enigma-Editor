'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const { once } = require('node:events')
const { pathToFileURL } = require('node:url')
const { createCipheriv, createDecipheriv, createHash } = require('node:crypto')
const { registerAgentConnectionIpc } = require('../agent-connection.cjs')

const desktopRoot = path.resolve(__dirname, '..')
const repositoryRoot = path.resolve(desktopRoot, '..')
const fixture = path.join(__dirname, 'windows-agent-loopback-fixture.py')
const python = process.env.VEE_TEST_PYTHON || 'python'

async function startFixture(testContext) {
  const isolatedRoot = path.join(desktopRoot, 'build', 'e2e-temp')
  await fs.mkdir(isolatedRoot, { recursive: true })
  const parent = await fs.mkdtemp(path.join(isolatedRoot, 'vee-agent-e2e-'))
  const base = path.join(parent, 'fixture')
  const child = spawn(python, [fixture, base], {
    cwd: repositoryRoot,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONPATH: [path.join(repositoryRoot, 'vps_agent'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      PYTHONIOENCODING: 'utf-8',
    },
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Loopback Agent readiness timed out: ${stderr}`)), 15_000)
    const finish = (error, value) => {
      clearTimeout(timer)
      child.off('exit', exited)
      lines.off('line', received)
      if (error) reject(error); else resolve(value)
    }
    const exited = code => finish(new Error(`Loopback Agent exited before readiness (${code}): ${stderr}`))
    const received = line => {
      try { finish(null, JSON.parse(line)) }
      catch (error) { finish(error) }
    }
    child.once('exit', exited)
    lines.once('line', received)
  })
  let stopped = false
  async function stop() {
    if (stopped) return
    stopped = true
    lines.close()
    await new Promise((resolve, reject) => {
      if (child.exitCode !== null) { resolve(); return }
      const timer = setTimeout(() => { child.kill(); finish(new Error('Loopback Agent did not stop')) }, 10_000)
      const finish = error => {
        clearTimeout(timer)
        child.off('exit', exited)
        if (error) reject(error); else resolve()
      }
      const exited = () => finish()
      child.once('exit', exited)
      child.stdin.end('stop\n')
    })
    await fs.rm(parent, { recursive: true, force: true })
  }
  testContext.after(stop)
  return { ready, base, stop }
}

function targetFor(ready, projectId, remoteRoot) {
  return {
    id: `loopback-${projectId}`,
    host: '127.0.0.1',
    port: ready.agentPort,
    domain: 'vee.test',
    remoteRoot,
    transport: 'vee-agent',
    certificateFingerprint: ready.certificateFingerprint,
  }
}

function deterministicSafeStorageStub() {
  // Test-only substitute so this Node process can exercise encrypted persistence.
  // It deliberately does not claim to reproduce Electron safeStorage/Windows DPAPI
  // profile binding, lock-state behavior, or OS-backed key protection.
  const key = createHash('sha256').update('VEE isolated IPC fixture key').digest()
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = createHash('sha256').update(value).digest().subarray(0, 12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted])
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
    },
  }
}

test('real Python HTTPS Agent pairs, publishes static/PHP releases, and rolls back on loopback', { timeout: 60_000, skip: process.platform !== 'win32' }, async t => {
  const { ready } = await startFixture(t)
  const clientTools = await import(pathToFileURL(path.join(desktopRoot, 'deploy', 'agent-client.mjs')).href)
  const planTools = await import(pathToFileURL(path.join(desktopRoot, 'deploy', 'plan.mjs')).href)
  let inMemoryToken = null
  const transport = clientTools.createHttpsAgentTransport({
    isEnabled: () => true,
    loadCredential: async () => inMemoryToken,
    saveCredential: async (_targetId, token) => { inMemoryToken = token },
  })
  const client = clientTools.createAgentClient({ transport })
  const staticTarget = targetFor(ready, 'static-project', ready.staticRoot)
  const phpTarget = targetFor(ready, 'php-project', ready.phpRoot)

  const paired = await client.pair(staticTarget, { pairingCode: ready.pairingCode, controllerName: 'VEE isolated E2E' })
  assert.equal(paired.paired, true)
  assert.match(inMemoryToken, /^[A-Za-z0-9_-]{20,128}$/)
  delete ready.pairingCode

  const status = await client.request(staticTarget, { operation: 'status' })
  assert.deepEqual(new Set(status.projectIds), new Set(['php-project', 'static-project']))
  assert.equal(status.shellAvailable, false)
  const firstInspect = await client.request(staticTarget, { operation: 'inspect-target', projectId: 'static-project' })
  assert.equal(firstInspect.currentReleaseId, ready.staticBootstrap)
  assert.equal(firstInspect.healthPath, ready.staticHealthPath)

  async function publish(target, projectId, kind, releaseId, previousReleaseId, healthPath, files) {
    const bundle = clientTools.createReleaseBundle({ projectId, releaseId, kind, files })
    const pending = planTools.createDeploymentPlan({ target, artifact: bundle.artifact, previousReleaseId, healthPath })
    const reviewed = planTools.reviewDeploymentPlan(pending, { reviewHash: pending.reviewHash })
    const approved = planTools.approveDeploymentPlan(reviewed, { reviewHash: pending.reviewHash, acknowledgement: 'I_APPROVE_DEPLOYMENT' })
    assert.equal(planTools.verifyDeploymentPlan(approved), true)
    return clientTools.executeDeploymentPlan({ plan: approved, client, bundleBase64: bundle.bundleBase64 })
  }

  const staticOne = await publish(staticTarget, 'static-project', 'static', 'static-release-1', ready.staticBootstrap, ready.staticHealthPath, [
    { path: 'index.html', contentBase64: Buffer.from('<h1>Static one</h1>').toString('base64') },
    { path: 'assets/site.css', contentBase64: Buffer.from('body{color:teal}').toString('base64') },
  ])
  assert.equal(staticOne.currentReleaseId, 'static-release-1')
  const markerOne = JSON.parse(await fs.readFile(path.join(ready.staticRoot, 'current', 'vee-release.json'), 'utf8'))
  assert.equal(markerOne.releaseId, 'static-release-1')

  const staticTwo = await publish(staticTarget, 'static-project', 'static', 'static-release-2', 'static-release-1', ready.staticHealthPath, [
    { path: 'index.html', contentBase64: Buffer.from('<h1>Static two</h1>').toString('base64') },
  ])
  assert.equal(staticTwo.currentReleaseId, 'static-release-2')
  assert.equal(staticTwo.previousReleaseId, 'static-release-1')
  const rolledBack = await client.request(staticTarget, { operation: 'rollback-release', projectId: 'static-project', payload: { toReleaseId: 'static-release-1' } })
  assert.equal(rolledBack.currentReleaseId, 'static-release-1')
  assert.equal(rolledBack.runtimeHealthVerified, true)
  const rolledMarker = JSON.parse(await fs.readFile(path.join(ready.staticRoot, 'current', 'vee-release.json'), 'utf8'))
  assert.equal(rolledMarker.releaseId, 'static-release-1')

  const phpInspect = await client.request(phpTarget, { operation: 'inspect-target', projectId: 'php-project' })
  assert.equal(phpInspect.currentReleaseId, ready.phpBootstrap)
  const phpPublished = await publish(phpTarget, 'php-project', 'php', 'php-release-1', ready.phpBootstrap, ready.phpHealthPath, [
    { path: 'index.php', contentBase64: Buffer.from('<?php echo "VEE PHP";').toString('base64') },
    { path: 'assets/app.js', contentBase64: Buffer.from('document.body.dataset.vee="ready"').toString('base64') },
  ])
  assert.equal(phpPublished.currentReleaseId, 'php-release-1')
  const phpMarker = JSON.parse(await fs.readFile(path.join(ready.phpRoot, 'current', 'vee-release.json'), 'utf8'))
  assert.equal(phpMarker.releaseId, 'php-release-1')

  const fetched = await fetch(`http://127.0.0.1:${ready.markerPort}/php-project/vee-release.json`)
  assert.equal(fetched.status, 200)
  assert.equal((await fetched.json()).releaseId, 'php-release-1')
})

test('trusted Desktop IPC performs settings, pair, prepare, publish, and rollback against the real loopback Agent', { timeout: 60_000, skip: process.platform !== 'win32' }, async t => {
  const { ready, base } = await startFixture(t)
  const workspace = path.join(base, 'desktop-source')
  const userData = path.join(base, 'desktop-user-data')
  await fs.mkdir(path.join(workspace, 'assets'), { recursive: true })
  await fs.writeFile(path.join(workspace, 'index.html'), '<h1>Trusted IPC release</h1>')
  await fs.writeFile(path.join(workspace, 'assets', 'site.css'), 'body{background:#10191f;color:#22d3c5}')
  await fs.writeFile(path.join(workspace, '.env'), 'MUST_NOT_SHIP=fixture-secret')

  const handlers = new Map()
  let online = true
  const safeStorage = deterministicSafeStorageStub()
  const connection = registerAgentConnectionIpc({
    registerTrustedHandler: (channel, handler) => handlers.set(channel, handler),
    safeStorage,
    app: { getPath: name => { assert.equal(name, 'userData'); return userData } },
    getWorkspaceRoot: async projectId => {
      assert.equal(projectId, 'desktop-static')
      return workspace
    },
    isOnline: () => online,
  })

  const settings = {
    host: '127.0.0.1',
    port: ready.agentPort,
    domain: 'vee.test',
    remoteRoot: ready.staticRoot,
    certificateFingerprint: ready.certificateFingerprint,
  }
  assert.equal((await handlers.get('vee:agent:save-settings')(settings)).paired, false)
  const paired = await handlers.get('vee:agent:pair')({ pairingCode: ready.pairingCode, controllerName: 'Trusted IPC E2E' })
  assert.equal(paired.paired, true)
  assert.equal(Object.hasOwn(paired, 'encryptedToken'), false)
  const persisted = await fs.readFile(path.join(userData, 'agent', 'connection.json'), 'utf8')
  assert.equal(persisted.includes(ready.pairingCode), false)
  const encryptedToken = JSON.parse(persisted).encryptedToken
  assert.equal(encryptedToken.length > 40, true)
  const decryptedToken = safeStorage.decryptString(Buffer.from(encryptedToken, 'base64'))
  assert.match(decryptedToken, /^[A-Za-z0-9_-]{20,128}$/)
  assert.equal(persisted.includes(decryptedToken), false)
  delete ready.pairingCode

  const status = await handlers.get('vee:agent:status')()
  assert.deepEqual(new Set(status.projectIds), new Set(['static-project', 'php-project']))
  const inspected = await handlers.get('vee:agent:inspect-project')('static-project')
  assert.equal(inspected.currentReleaseId, ready.staticBootstrap)
  const review = await handlers.get('vee:agent:prepare-release')({ localProjectId: 'desktop-static', serverProjectId: 'static-project', kind: 'static' })
  assert.equal(review.previousReleaseId, ready.staticBootstrap)
  assert.deepEqual(review.files.map(file => file.path), ['assets/site.css', 'index.html'])
  assert.deepEqual(review.excluded, [{ path: '.env', reason: 'Private, dependency, or credential file' }])
  assert.deepEqual(review.operations, ['inspect-target', 'stage-release', 'health-check', 'switch-release', 'health-check'])

  const published = await handlers.get('vee:agent:publish')({ reviewId: review.reviewId, reviewHash: review.reviewHash, acknowledgement: 'I_APPROVE_DEPLOYMENT' })
  assert.equal(published.state, 'published')
  assert.equal(published.currentReleaseId, review.releaseId)
  const afterPublish = await handlers.get('vee:agent:inspect-project')('static-project')
  assert.equal(afterPublish.previousReleaseId, ready.staticBootstrap)
  const rollback = await handlers.get('vee:agent:rollback')({ serverProjectId: 'static-project', toReleaseId: ready.staticBootstrap, confirmation: 'ROLLBACK RELEASE' })
  assert.equal(rollback.state, 'rolled-back')
  assert.equal(rollback.currentReleaseId, ready.staticBootstrap)
  assert.equal((await handlers.get('vee:agent:inspect-project')('static-project')).currentReleaseId, ready.staticBootstrap)

  online = false
  await assert.rejects(() => handlers.get('vee:agent:status')(), /Offline Mode/)
  assert.equal(connection.isBusy(), false)
})
