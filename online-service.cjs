'use strict'

const https = require('node:https')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')

const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const HASH = /^[a-f0-9]{64}$/
const TYPES = ['block', 'theme', 'plugin', 'mod', 'template']

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.length > 500 || /[\x00-\x20\x7f\\]/.test(value)) {
    throw new Error('Enter the HTTPS address of your VEE account service')
  }
  let url
  try { url = new URL(value) } catch { throw new Error('Enter a valid HTTPS service address') }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash ||
      !/^\/[A-Za-z0-9/_.~-]*$/.test(url.pathname)) {
    throw new Error('The account service must use HTTPS without credentials, query, or fragment')
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/api$/, '')
  return url.toString().replace(/\/+$/, '')
}

function limitedString(value, maximum, label, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function profileInput(input) {
  if (!input || typeof input !== 'object') throw new Error('Profile details are required')
  if (!['beginner', 'intermediate', 'advanced', 'professional'].includes(input.experienceLevel)) throw new Error('Choose an experience level')
  if (!['en', 'fa'].includes(input.locale)) throw new Error('Choose English or Persian')
  return {
    displayName: limitedString(input.displayName, 120, 'display name'),
    organizationName: limitedString(input.organizationName, 120, 'organization name'),
    experienceLevel: input.experienceLevel,
    locale: input.locale,
  }
}

function credentials(input) {
  if (!input || typeof input !== 'object') throw new Error('Email and password are required')
  return {
    email: limitedString(input.email, 255, 'email address'),
    password: limitedString(input.password, 1024, 'password'),
  }
}

function publicUser(value) {
  if (value === null) return null
  if (!value || typeof value !== 'object' || !ID.test(value.id) || !ID.test(value.organization?.id) ||
      !['beginner', 'intermediate', 'advanced', 'professional'].includes(value.experienceLevel)) {
    throw new Error('The account service returned invalid account information')
  }
  return {
    id: value.id,
    email: limitedString(value.email, 255, 'account email'),
    displayName: limitedString(value.displayName, 120, 'account name'),
    role: limitedString(value.role, 50, 'account role'),
    experienceLevel: value.experienceLevel,
    locale: limitedString(value.locale, 20, 'account language'),
    organization: { id: value.organization.id, name: limitedString(value.organization.name, 160, 'organization name') },
  }
}

/** HTTPS only, system CA verification, no redirects, bounded response and deadline. */
function httpsTransport({ url, method, headers, body, signal, maxBytes }) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    const request = https.request(url, { method, headers, signal, rejectUnauthorized: true }, response => {
      const declared = response.headers['content-length']
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
        response.destroy(new Error('The account service response exceeds the size limit'))
        return
      }
      response.on('data', chunk => {
        size += chunk.length
        if (size > maxBytes) response.destroy(new Error('The account service response exceeds the size limit'))
        else chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }))
    })
    const timer = setTimeout(() => request.destroy(new Error('Account service request timed out')), 30_000)
    timer.unref?.()
    request.on('close', () => clearTimeout(timer))
    request.on('error', reject)
    if (body) request.write(body)
    request.end()
  })
}

/** Private, bounded session cookie jar. Session material never enters renderer or disk. */
class SessionCookie {
  constructor() { this.clear() }
  clear() { this.value = null; this.expiresAt = 0 }
  header() {
    if (this.expiresAt && this.expiresAt <= Date.now()) this.clear()
    return this.value || ''
  }
  accept(headers) {
    const lines = headers['set-cookie'] || []
    if (!Array.isArray(lines) || lines.length > 20) throw new Error('Invalid account service cookie response')
    for (const line of lines) {
      if (typeof line !== 'string' || line.length > 8192) throw new Error('Invalid account service cookie response')
      const parts = line.split(';').map(part => part.trim())
      const match = /^(__Host-vee_session)=([A-Za-z0-9,-]*)$/.exec(parts[0])
      if (!match) continue
      const attributes = new Map(parts.slice(1).map(part => {
        const index = part.indexOf('=')
        return [part.slice(0, index === -1 ? undefined : index).toLowerCase(), index === -1 ? '' : part.slice(index + 1)]
      }))
      if (!attributes.has('secure') || !attributes.has('httponly') || attributes.get('path') !== '/' || attributes.has('domain')) {
        throw new Error('The account service did not provide a secure session cookie')
      }
      const expiry = attributes.has('expires') ? Date.parse(attributes.get('expires')) : 0
      const age = attributes.has('max-age') ? Number(attributes.get('max-age')) : null
      if (!match[2] || (Number.isFinite(expiry) && expiry > 0 && expiry <= Date.now()) || (age !== null && age <= 0)) this.clear()
      else {
        this.value = parts[0]
        this.expiresAt = age !== null && Number.isFinite(age) ? Date.now() + Math.min(age, 43200) * 1000 : (Number.isFinite(expiry) ? expiry : 0)
      }
    }
  }
}

class OnlineService {
  constructor({ transport = httpsTransport, isOnline = () => true, settingsPath, chooseUpload, chooseDownload }) {
    this.transport = transport
    this.isOnline = isOnline
    this.settingsPath = settingsPath
    this.chooseUpload = chooseUpload
    this.chooseDownload = chooseDownload
    this.baseUrl = ''
    this.connected = false
    this.setupRequired = false
    this.user = null
    this.csrf = ''
    this.cookie = new SessionCookie()
    this.controllers = new Set()
    this.listing = new Map()
    this.inspectTokens = new Set()
    this.queue = Promise.resolve()
    this.generation = 0
    this.configurationError = null
  }

  async initialize() {
    if (!this.settingsPath) return
    try {
      const raw = await fs.readFile(this.settingsPath, 'utf8')
      if (raw.length > 2048) throw new Error('Invalid account service settings')
      this.baseUrl = normalizeBaseUrl(JSON.parse(raw).baseUrl)
    } catch (error) {
      // A damaged optional online configuration must never stop the local IDE.
      if (error.code !== 'ENOENT') this.configurationError = 'Saved account service settings could not be read. Enter the HTTPS address again'
    }
  }

  status() {
    const online = this.isOnline()
    return { baseUrl: this.baseUrl, connected: online && this.connected, authenticated: online && this.connected && Boolean(this.user),
      user: this.user ? structuredClone(this.user) : null, setupRequired: this.setupRequired, offlineMode: !online,
      configurationError: this.configurationError }
  }

  cancel() {
    this.generation++
    this.connected = false
    this.listing.clear()
    this.inspectTokens.clear()
    for (const controller of this.controllers) controller.abort()
  }

  enqueue(operation) {
    const generation = this.generation
    const pending = this.queue.then(() => {
      if (generation !== this.generation) throw new Error('The online request was stopped. Reconnect to check its result')
      return operation()
    })
    this.queue = pending.catch(() => {})
    return pending
  }

  assertOnline() {
    if (!this.isOnline()) throw new Error('Turn off Offline Mode to use accounts and Community')
    if (!this.baseUrl) throw new Error('Connect your VEE account service first')
  }

  async saveSettings() {
    if (!this.settingsPath) return
    await fs.mkdir(path.dirname(this.settingsPath), { recursive: true, mode: 0o700 })
    const temporary = `${this.settingsPath}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify({ baseUrl: this.baseUrl }), { flag: 'wx', mode: 0o600 })
      await fs.rename(temporary, this.settingsPath)
    } finally { await fs.unlink(temporary).catch(() => {}) }
  }

  clearSession() {
    this.user = null; this.csrf = ''; this.cookie.clear(); this.listing.clear(); this.inspectTokens.clear()
  }

  async request(endpoint, { method = 'GET', data, body, contentType, binary = false, maximum = MAX_JSON_BYTES } = {}) {
    this.assertOnline()
    const controller = new AbortController()
    const generation = this.generation
    const payload = body || (data !== undefined ? Buffer.from(JSON.stringify(data)) : null)
    const headers = { Accept: binary ? 'application/octet-stream' : 'application/json', Origin: new URL(this.baseUrl).origin, 'User-Agent': 'VisualEnigmaEditor-Desktop' }
    const cookie = this.cookie.header()
    if (cookie) headers.Cookie = cookie
    if (method !== 'GET') {
      if (!this.csrf) throw new Error('Reconnect to refresh the account session')
      headers['X-CSRF-Token'] = this.csrf
    }
    this.controllers.add(controller)
    if (payload) { headers['Content-Type'] = contentType || 'application/json'; headers['Content-Length'] = String(payload.length) }
    let response
    try {
      response = await this.transport({ url: `${this.baseUrl}/api/${endpoint}`, method, headers, body: payload, signal: controller.signal, maxBytes: maximum })
      if (controller.signal.aborted || generation !== this.generation || !this.isOnline()) throw new Error('cancelled')
    } catch {
      this.connected = false
      if (controller.signal.aborted || generation !== this.generation || !this.isOnline()) throw new Error('The online request was stopped. Reconnect to check its result')
      throw new Error('The VEE account service is unavailable. Local projects remain available')
    } finally { this.controllers.delete(controller) }
    if (!response || !Buffer.isBuffer(response.body) || response.body.length > maximum) throw new Error('The account service response exceeds the size limit')
    if (response.status >= 300 && response.status < 400) throw new Error('The account service redirected the request. Use its final HTTPS address')
    this.cookie.accept(response.headers)
    let result
    if (!binary || response.status < 200 || response.status >= 300) {
      if (!String(response.headers['content-type'] || '').toLowerCase().includes('application/json')) throw new Error('The address did not return the VEE account API')
      try { result = JSON.parse(response.body.toString('utf8')) } catch { throw new Error('The account service returned invalid JSON') }
    }
    if (response.status < 200 || response.status >= 300) {
      if (response.status === 401) { this.clearSession() }
      const message = typeof result?.error === 'string' && result.error.length <= 240 && !/[\x00-\x1f\x7f]/.test(result.error) ? result.error : `Account service request failed (${response.status})`
      throw new Error(message)
    }
    this.connected = true
    return binary ? response : result
  }

  async refresh() {
    const session = await this.request('session')
    if (!session || typeof session.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{32,200}$/.test(session.csrfToken) || typeof session.setupRequired !== 'boolean') {
      throw new Error('The account service returned invalid session information')
    }
    const user = publicUser(session.user)
    if (user?.id !== this.user?.id) { this.listing.clear(); this.inspectTokens.clear() }
    this.user = user
    this.csrf = session.csrfToken
    this.setupRequired = session.setupRequired
    return this.status()
  }

  connect(baseUrl) {
    const normalized = normalizeBaseUrl(baseUrl)
    this.cancel()
    return this.enqueue(async () => {
      if (!this.isOnline()) throw new Error('Turn off Offline Mode before connecting your account service')
      if (normalized !== this.baseUrl) this.clearSession()
      this.baseUrl = normalized
      await this.saveSettings()
      this.configurationError = null
      return this.refresh()
    })
  }

  disconnect() {
    this.cancel()
    return this.enqueue(async () => {
      this.clearSession(); this.baseUrl = ''; this.connected = false; this.setupRequired = false; this.configurationError = null
      if (this.settingsPath) await fs.unlink(this.settingsPath).catch(error => { if (error.code !== 'ENOENT') throw error })
      return this.status()
    })
  }

  login(input) { const data = credentials(input); return this.enqueue(async () => { await this.refresh(); await this.request('auth/login', { method: 'POST', data }); return this.refresh() }) }
  register(input) {
    const data = { ...credentials(input), ...profileInput(input) }
    return this.enqueue(async () => { await this.refresh(); await this.request('auth/register', { method: 'POST', data }); return this.refresh() })
  }
  logout() {
    return this.enqueue(async () => {
      try { if (this.csrf) await this.request('auth/logout', { method: 'POST', data: {} }) }
      finally { this.clearSession() }
      return this.status()
    })
  }
  logoutOtherSessions(password) {
    const data = { password: limitedString(password, 1024, 'password') }
    return this.enqueue(async () => { await this.requireAccount(); await this.request('auth/logout-other-sessions', { method: 'POST', data }); return this.refresh() })
  }
  updateProfile(input) {
    const data = profileInput(input)
    return this.enqueue(async () => { await this.requireAccount(); await this.request('account/profile', { method: 'PATCH', data }); return this.refresh() })
  }
  requestPasswordReset(email) {
    const data = { email: limitedString(email, 255, 'email address') }
    return this.enqueue(async () => {
      await this.refresh()
      const result = await this.request('auth/password-reset/request', { method: 'POST', data })
      return { message: limitedString(result?.message, 500, 'reset message') }
    })
  }
  confirmPasswordReset(input) {
    const data = { token: limitedString(input?.token, 200, 'reset token'), password: limitedString(input?.password, 1024, 'password') }
    return this.enqueue(async () => {
      await this.refresh()
      await this.request('auth/password-reset/confirm', { method: 'POST', data })
      this.clearSession()
      return { ok: true }
    })
  }
  async requireAccount() { await this.refresh(); if (!this.user) throw new Error('Sign in to use this feature') }
  entitlements() {
    return this.enqueue(async () => {
      await this.requireAccount()
      const result = await this.request('account/entitlements')
      if (!result || !['free', 'pro'].includes(result.plan) || !Number.isSafeInteger(result.activeWebsiteLimit) || result.activeWebsiteLimit < 0 ||
          !Number.isSafeInteger(result.activeWebsites) || result.activeWebsites < 0 || !result.features || typeof result.features !== 'object' || Array.isArray(result.features) ||
          Object.keys(result.features).length > 200 || Object.entries(result.features).some(([key, value]) => !/^[a-z0-9._-]{1,100}$/i.test(key) || typeof value !== 'boolean') ||
          (result.expiresAt !== null && typeof result.expiresAt !== 'string')) throw new Error('The account service returned invalid Pro entitlements')
      return { plan: result.plan, activeWebsiteLimit: result.activeWebsiteLimit, activeWebsites: result.activeWebsites, features: { ...result.features }, expiresAt: result.expiresAt }
    })
  }
  async listPackages() {
    const result = await this.request('community/packages')
    if (!Array.isArray(result?.items) || result.items.length > 100) throw new Error('Invalid Community listing')
    const items = result.items.map(item => {
      if (!item || !ID.test(item.id) || !TYPES.includes(item.type) || !HASH.test(item.checksum) || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 1 || item.sizeBytes > MAX_PACKAGE_BYTES ||
          !Array.isArray(item.permissions) || item.permissions.length > 100 || item.permissions.some(permission => typeof permission !== 'string' || permission.length > 100)) throw new Error('Invalid Community package metadata')
      return { id: item.id, name: limitedString(item.name, 120, 'package name'), type: item.type, version: limitedString(item.version, 50, 'package version'),
        author: limitedString(item.author, 160, 'package author'), permissions: [...item.permissions], checksum: item.checksum, sizeBytes: item.sizeBytes,
        signatureStatus: limitedString(item.signatureStatus, 50, 'package signature'), signerKeyId: item.signerKeyId === null ? null : limitedString(item.signerKeyId, 120, 'signer'), publishedAt: limitedString(item.publishedAt, 100, 'publication date') }
    })
    this.listing = new Map(items.map(item => [item.id, item]))
    return { items }
  }
  communityList() { return this.enqueue(async () => { await this.requireAccount(); return this.listPackages() }) }
  communityMine() {
    return this.enqueue(async () => {
      await this.requireAccount()
      const result = await this.request('community/submissions')
      if (!Array.isArray(result?.items) || result.items.length > 100) throw new Error('Invalid Community submissions')
      return { items: result.items.map(item => {
        if (!item || !ID.test(item.id) || !TYPES.includes(item.type) || !HASH.test(item.checksum) || !['pending', 'approved', 'rejected', 'revoked'].includes(item.status)) throw new Error('Invalid submission metadata')
        return { id: item.id, name: limitedString(item.name, 120, 'package name'), type: item.type, version: limitedString(item.version, 50, 'package version'),
          author: limitedString(item.author, 160, 'package author'), checksum: item.checksum, signatureStatus: limitedString(item.signatureStatus, 50, 'package signature'), status: item.status,
          reviewNote: item.reviewNote === null ? null : limitedString(item.reviewNote, 2000, 'review note', true), createdAt: limitedString(item.submittedAt, 100, 'submission date'), reviewedAt: item.reviewedAt === null ? null : limitedString(item.reviewedAt, 100, 'review date') }
      }) }
    })
  }
  communityInspectFile() {
    return this.enqueue(async () => {
      const generation = this.generation
      await this.requireAccount()
      const filename = await this.chooseUpload()
      if (!filename) return null
      if (generation !== this.generation) throw new Error('The online request was stopped. Reconnect before inspecting a package')
      this.assertOnline()
      if (path.extname(filename).toLowerCase() !== '.pspkg') throw new Error('Choose a .pspkg package')
      const stat = await fs.lstat(filename)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_PACKAGE_BYTES) throw new Error('Choose a regular .pspkg file smaller than 100 MB')
      const handle = await fs.open(filename, 'r')
      let bytes
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || opened.size !== stat.size || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('The selected package changed; select it again')
        bytes = Buffer.alloc(opened.size)
        let offset = 0
        while (offset < bytes.length) {
          const read = await handle.read(bytes, offset, bytes.length - offset, offset)
          if (!read.bytesRead) throw new Error('The selected package changed; select it again')
          offset += read.bytesRead
        }
        const after = await handle.stat()
        if (after.size !== stat.size || after.mtimeMs !== opened.mtimeMs) throw new Error('The selected package changed; select it again')
      } finally { await handle.close() }
      if (generation !== this.generation) throw new Error('The online request was stopped. Reconnect before inspecting a package')
      const fileName = path.basename(filename)
      const boundary = `vee-${randomUUID()}`
      const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="package"; filename="package.pspkg"\r\nContent-Type: application/octet-stream\r\n\r\n`)
      const body = Buffer.concat([prefix, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)])
      const result = await this.request('packages/inspect', { method: 'POST', body, contentType: `multipart/form-data; boundary=${boundary}` })
      if (!result || !HASH.test(result.installToken) || !result.manifest || typeof result.manifest !== 'object' || Array.isArray(result.manifest) ||
          !TYPES.includes(result.manifest.type) || !Array.isArray(result.permissions) || result.permissions.length > 100 || result.permissions.some(item => typeof item !== 'string' || item.length > 100)) throw new Error('Invalid package inspection response')
      const manifest = { ...result.manifest,
        name: limitedString(result.manifest.name, 120, 'package name'),
        version: limitedString(result.manifest.version, 50, 'package version'),
        author: limitedString(result.manifest.author, 160, 'package author'),
      }
      if (createHash('sha256').update(bytes).digest('hex') !== result.installToken) throw new Error('The inspected package does not match your selected file')
      this.inspectTokens.add(result.installToken)
      if (this.inspectTokens.size > 20) this.inspectTokens.delete(this.inspectTokens.values().next().value)
      return { fileName, manifest, permissions: result.permissions,
        installToken: result.installToken, signatureStatus: limitedString(result.signatureStatus, 50, 'package signature'), signerKeyId: result.signerKeyId === null ? null : limitedString(result.signerKeyId, 120, 'signer') }
    })
  }
  communitySubmit(input) {
    if (!input || input.confirmRights !== true || !HASH.test(input.installToken)) throw new Error('Confirm your rights to share this inspected package')
    return this.enqueue(async () => {
      await this.requireAccount()
      if (!this.inspectTokens.has(input.installToken)) throw new Error('Inspect your package in this session before submitting it')
      const result = await this.request('community/submissions', { method: 'POST', data: { installToken: input.installToken, confirmRights: true } })
      if (!ID.test(result?.id) || result.status !== 'pending') throw new Error('Invalid submission response')
      this.inspectTokens.delete(input.installToken)
      return { id: result.id, status: 'pending' }
    })
  }
  communityDownload(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Choose a Community package')
    return this.enqueue(async () => {
      const generation = this.generation
      await this.requireAccount()
      await this.listPackages()
      const item = this.listing.get(id)
      if (!item) throw new Error('This package is no longer available')
      const destination = await this.chooseDownload(`${item.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'package'}-${item.version.replace(/[^A-Za-z0-9._-]/g, '_')}.pspkg`)
      if (!destination) return null
      if (generation !== this.generation) throw new Error('The online request was stopped. Reconnect before downloading a package')
      this.assertOnline()
      if (path.extname(destination).toLowerCase() !== '.pspkg') throw new Error('Save the file with the .pspkg extension')
      const response = await this.request(`community/packages/${id}/download`, { binary: true, maximum: Math.min(MAX_PACKAGE_BYTES, item.sizeBytes) })
      const checksum = createHash('sha256').update(response.body).digest('hex')
      if (response.headers['x-package-sha256'] !== item.checksum || checksum !== item.checksum || response.body.length !== item.sizeBytes) throw new Error('Package integrity verification failed; no file was saved')
      // Save as a new file only: never overwrite an existing source/package silently.
      const handle = await fs.open(destination, 'wx', 0o600).catch(error => {
        if (error.code === 'EEXIST') throw new Error('A file already exists there. Choose a new filename')
        throw error
      })
      try { await handle.writeFile(response.body); await handle.sync() }
      catch (error) { await handle.close(); await fs.unlink(destination).catch(() => {}); throw error }
      await handle.close()
      return { fileName: path.basename(destination), sha256: checksum, sizeBytes: item.sizeBytes }
    })
  }
}

async function registerOnlineServiceIpc({ registerTrustedHandler, app, dialog, getWindow, isOnline }) {
  const service = new OnlineService({
    isOnline,
    settingsPath: path.join(app.getPath('userData'), 'online', 'service.json'),
    chooseUpload: async () => {
      const result = await dialog.showOpenDialog(getWindow(), { title: 'Inspect a Community package', properties: ['openFile'], filters: [{ name: 'VEE package', extensions: ['pspkg'] }] })
      return result.canceled ? null : result.filePaths[0] || null
    },
    chooseDownload: async defaultPath => {
      const result = await dialog.showSaveDialog(getWindow(), { title: 'Save verified Community package', defaultPath, filters: [{ name: 'VEE package', extensions: ['pspkg'] }] })
      return result.canceled ? null : result.filePath || null
    },
  })
  await service.initialize()
  const methods = {
    status: () => service.status(), connect: baseUrl => service.connect(baseUrl), disconnect: () => service.disconnect(),
    login: input => service.login(input), register: input => service.register(input), logout: () => service.logout(),
    'logout-other-sessions': password => service.logoutOtherSessions(password), 'update-profile': input => service.updateProfile(input),
    entitlements: () => service.entitlements(), 'request-password-reset': email => service.requestPasswordReset(email),
    'confirm-password-reset': input => service.confirmPasswordReset(input),
    'community-list': () => service.communityList(), 'community-mine': () => service.communityMine(),
    'community-inspect': () => service.communityInspectFile(), 'community-submit': input => service.communitySubmit(input),
    'community-download': id => service.communityDownload(id),
  }
  for (const [name, handler] of Object.entries(methods)) registerTrustedHandler(`vee:online:${name}`, handler)
  return service
}

module.exports = { OnlineService, SessionCookie, normalizeBaseUrl, httpsTransport, registerOnlineServiceIpc, MAX_JSON_BYTES, MAX_PACKAGE_BYTES }
