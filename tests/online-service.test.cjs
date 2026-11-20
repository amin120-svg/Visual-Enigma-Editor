'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { OnlineService, SessionCookie, normalizeBaseUrl, MAX_JSON_BYTES } = require('../online-service.cjs')

const user = { id: 'cc4e2259-e6f5-4484-854f-26777c4567e6', email: 'person@example.invalid', displayName: 'Example', role: 'administrator', experienceLevel: 'beginner', locale: 'en', organization: { id: '8ac3fe8e-1126-475d-b701-bd511f1cd01f', name: 'Example' } }
const csrf = 'a'.repeat(43)
const sessionCookie = '__Host-vee_session=initial-session; Path=/; Secure; HttpOnly; SameSite=Lax'
const json = (data, status = 200, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: Buffer.from(JSON.stringify(data)) })
const state = authenticated => json({ csrfToken: csrf, setupRequired: false, user: authenticated ? user : null }, 200, { 'set-cookie': [sessionCookie] })

function fixture(overrides = {}) {
  const calls = []
  let authenticated = false
  const service = new OnlineService({
    transport: async request => {
      calls.push(request)
      const route = new URL(request.url).pathname.replace('/api/', '')
      if (overrides[route]) return overrides[route](request)
      if (route === 'session') return state(authenticated)
      if (route === 'auth/login') { authenticated = true; return json({ ok: true, csrfToken: 'b'.repeat(43) }, 200, { 'set-cookie': ['__Host-vee_session=rotated-session; Path=/; Secure; HttpOnly; SameSite=Lax'] }) }
      if (route === 'auth/logout') { authenticated = false; return json({ ok: true }) }
      if (route === 'community/packages') return json({ items: [] })
      return json({ ok: true })
    },
  })
  return { service, calls }
}

test('service URL rejects insecure or credential-bearing addresses; supports subdirectory installs', () => {
  assert.equal(normalizeBaseUrl('https://example.invalid/tools/vee/api/'), 'https://example.invalid/tools/vee')
  for (const input of ['http://example.invalid', 'https://person:secret@example.invalid', 'https://example.invalid/?x=1', 'https://example.invalid/#x', 'https://example.invalid/\n', 'file:///tmp']) {
    assert.throws(() => normalizeBaseUrl(input))
  }
})

test('private cookie jar accepts only secure host-only HttpOnly PHP session and expires logout', () => {
  const cookie = new SessionCookie()
  cookie.accept({ 'set-cookie': [sessionCookie, 'advertising=ignored; Path=/'] })
  assert.equal(cookie.header(), '__Host-vee_session=initial-session')
  for (const line of ['__Host-vee_session=x; Path=/; HttpOnly', '__Host-vee_session=x; Path=/; Secure', '__Host-vee_session=x; Path=/; Secure; HttpOnly; Domain=example.invalid']) {
    assert.throws(() => cookie.accept({ 'set-cookie': [line] }))
  }
  cookie.accept({ 'set-cookie': ['__Host-vee_session=; Path=/; Secure; HttpOnly; Max-Age=0'] })
  assert.equal(cookie.header(), '')
})

test('login keeps cookies and CSRF in main process; requests use service origin and refreshed CSRF', async () => {
  const { service, calls } = fixture()
  const connected = await service.connect('https://example.invalid')
  assert.equal(connected.authenticated, false)
  const loggedIn = await service.login({ email: user.email, password: 'generated-at-request-time' })
  assert.equal(loggedIn.authenticated, true)
  assert.equal(loggedIn.user.organization.id, user.organization.id)
  assert.equal(JSON.stringify(loggedIn).includes('csrf'), false)
  assert.equal(JSON.stringify(loggedIn).includes('session='), false)
  const login = calls.find(call => call.url.endsWith('/auth/login'))
  assert.equal(login.headers['X-CSRF-Token'], csrf)
  assert.equal(login.headers.Cookie, '__Host-vee_session=initial-session')
  assert.equal(login.headers.Origin, 'https://example.invalid')
  assert.equal(calls.at(-1).headers.Cookie, '__Host-vee_session=rotated-session')
  await service.logout()
  assert.equal(service.status().user, null)
  assert.equal(service.cookie.header(), '')
})

test('redirect and oversized or non-JSON responses are refused without following another endpoint', async () => {
  for (const response of [
    { status: 302, headers: { location: 'https://attacker.invalid' }, body: Buffer.alloc(0) },
    { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>not API</html>') },
    { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.alloc(MAX_JSON_BYTES + 1) },
  ]) {
    let count = 0
    const service = new OnlineService({ transport: async () => { count++; return response } })
    await assert.rejects(service.connect('https://example.invalid'))
    assert.equal(count, 1)
    assert.equal(service.status().authenticated, false)
  }
})

test('offline mode aborts inflight and invalidates queued online operations even after mode returns', async () => {
  let online = true
  let started
  const entered = new Promise(resolve => { started = resolve })
  const service = new OnlineService({ isOnline: () => online, transport: request => new Promise((_resolve, reject) => {
    started()
    request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  }) })
  const connection = service.connect('https://example.invalid')
  await entered
  const queued = service.communityList()
  online = false
  service.cancel()
  online = true
  await assert.rejects(connection, /stopped/)
  await assert.rejects(queued, /stopped/)
  assert.equal(service.controllers.size, 0)
  assert.equal(service.status().connected, false)
})

test('unauthorized responses clear cached auth and never expose server debug detail', async () => {
  const { service } = fixture({ 'account/entitlements': () => json({ error: 'Authentication required', detail: 'private SQL text' }, 401) })
  await service.connect('https://example.invalid')
  await service.login({ email: user.email, password: 'generated-at-request-time' })
  await assert.rejects(service.entitlements(), error => error.message === 'Authentication required')
  assert.equal(service.status().authenticated, false)
  assert.equal(service.cookie.header(), '')
})

test('settings restore endpoint only without starting network or persisting credentials', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vee-online-settings-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const settingsPath = path.join(directory, 'service.json')
  const { service } = fixture()
  service.settingsPath = settingsPath
  await service.connect('https://example.invalid')
  await service.login({ email: user.email, password: 'generated-at-request-time' })
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')), { baseUrl: 'https://example.invalid' })
  let count = 0
  const restored = new OnlineService({ settingsPath, transport: async () => { count++; throw new Error('must not connect') } })
  await restored.initialize()
  assert.equal(count, 0)
  assert.equal(restored.status().authenticated, false)
  assert.equal(restored.status().baseUrl, 'https://example.invalid')
  await fs.writeFile(settingsPath, '{broken')
  const damaged = new OnlineService({ settingsPath })
  await damaged.initialize()
  assert.equal(damaged.status().baseUrl, '')
  assert.match(damaged.status().configurationError, /could not be read/)
})

test('verified Community downloads refuse tampering and existing files; save exact bytes after hash check', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vee-community-download-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const destination = path.join(directory, 'package.pspkg')
  const bytes = Buffer.from('authorized fixture bytes')
  const checksum = createHash('sha256').update(bytes).digest('hex')
  const id = 'f1f8af2a-82ea-486f-ae48-bdf78c3921f5'
  const packageItem = { id, name: 'Example', type: 'block', version: '2026.10', author: 'Author', permissions: [], checksum, sizeBytes: bytes.length, signatureStatus: 'unsigned', signerKeyId: null, publishedAt: '2026-10-17T00:00:00Z' }
  let downloadBytes = Buffer.from('tampered')
  const { service } = fixture({
    'community/packages': () => json({ items: [packageItem] }),
    [`community/packages/${id}/download`]: () => ({ status: 200, headers: { 'x-package-sha256': checksum }, body: downloadBytes }),
  })
  service.chooseDownload = async () => destination
  await service.connect('https://example.invalid')
  await service.login({ email: user.email, password: 'generated-at-request-time' })
  await assert.rejects(service.communityDownload(id), /integrity/)
  await assert.rejects(fs.access(destination), { code: 'ENOENT' })
  downloadBytes = bytes
  const saved = await service.communityDownload(id)
  assert.equal(saved.sha256, checksum)
  assert.deepEqual(await fs.readFile(destination), bytes)
  await assert.rejects(service.communityDownload(id), /already exists/)
  assert.deepEqual(await fs.readFile(destination), bytes)
})

test('native-selected upload hash binds inspect token; submits only inspected session hashes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vee-community-upload-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'package.pspkg')
  const bytes = Buffer.from('fixture zip bytes, never executed')
  await fs.writeFile(filename, bytes)
  const checksum = createHash('sha256').update(bytes).digest('hex')
  let returnedToken = 'b'.repeat(64)
  let returnedManifest = { name: 'Example', type: 'block', version: '2026.10', author: 'Author' }
  const { service, calls } = fixture({
    'packages/inspect': () => json({ installToken: returnedToken, manifest: returnedManifest, permissions: ['blocks.register'], signatureStatus: 'unsigned', signerKeyId: null }),
    'community/submissions': () => json({ id: 'f1f8af2a-82ea-486f-ae48-bdf78c3921f5', status: 'pending' }, 201),
  })
  service.chooseUpload = async () => filename
  await service.connect('https://example.invalid')
  await service.login({ email: user.email, password: 'generated-at-request-time' })
  await assert.rejects(service.communityInspectFile(), /does not match/)
  await assert.rejects(service.communitySubmit({ installToken: checksum, confirmRights: true }), /Inspect your package/)
  returnedToken = checksum
  returnedManifest = { ...returnedManifest, name: { text: 'not a package name' } }
  await assert.rejects(service.communityInspectFile(), /Invalid package name/)
  await assert.rejects(service.communitySubmit({ installToken: checksum, confirmRights: true }), /Inspect your package/)
  returnedManifest = { ...returnedManifest, name: 'Example' }
  const inspected = await service.communityInspectFile()
  assert.equal(inspected.fileName, 'package.pspkg')
  const upload = calls.find(call => call.url.endsWith('/packages/inspect'))
  assert.equal(upload.headers['Content-Type'].startsWith('multipart/form-data; boundary=vee-'), true)
  assert.equal(upload.body.includes(bytes), true)
  const submitted = await service.communitySubmit({ installToken: checksum, confirmRights: true })
  assert.equal(submitted.status, 'pending')
  await assert.rejects(service.communitySubmit({ installToken: checksum, confirmRights: true }), /Inspect your package/)
})

test('changing connection or Offline Mode during a native picker prevents a delayed upload', async () => {
  const { service, calls } = fixture()
  await service.connect('https://example.invalid')
  await service.login({ email: user.email, password: 'generated-at-request-time' })
  let choose
  let started
  const pickerEntered = new Promise(resolve => { started = resolve })
  service.chooseUpload = () => new Promise(resolve => { choose = resolve; started() })
  const pending = service.communityInspectFile()
  await pickerEntered
  service.cancel()
  choose('D:/a-file-that-must-not-be-read.pspkg')
  await assert.rejects(pending, /stopped/)
  assert.equal(calls.some(call => call.url.endsWith('/packages/inspect')), false)
})
