'use strict'

const { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, session } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { WorkspaceStore } = require('./workspace.cjs')
const { registerAgentConnectionIpc } = require('./agent-connection.cjs')
const { registerOnlineServiceIpc } = require('./online-service.cjs')

const SCHEME = 'vee-app'
const APP_URL = `${SCHEME}://app/index.html`
const RENDERER_ROOT = path.join(__dirname, 'renderer')
const AI_RUNTIME = path.join(__dirname, 'build', 'ai-runtime.cjs')
const MAX_AI_SOURCE_CHARS = 100_000
const MAX_AI_INSTRUCTION_CHARS = 10_000
const MAX_AI_PROPOSAL_BYTES = 2 * 1024 * 1024
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}])

let mainWindow = null
let aiRequestInFlight = false
let aiAbortController = null
let offlineMode = false
let agentConnection = null
let onlineService = null

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function mimeFor(file) {
  return ({
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    '.wasm': 'application/wasm', '.map': 'application/json; charset=utf-8',
  })[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

function installRendererProtocol() {
  protocol.handle(SCHEME, async request => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'app' || request.method !== 'GET') return new Response('Not found', { status: 404 })
      const pathname = decodeURIComponent(url.pathname)
      if (pathname.includes('\\') || pathname.includes('\0')) return new Response('Not found', { status: 404 })
      const file = path.resolve(RENDERER_ROOT, pathname.slice(1))
      if (!isWithin(RENDERER_ROOT, file) || !(await fs.stat(file)).isFile()) return new Response('Not found', { status: 404 })
      const response = await net.fetch(pathToFileURL(file).toString())
      const headers = new Headers(response.headers)
      headers.set('Content-Type', mimeFor(file))
      headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY)
      headers.set('X-Content-Type-Options', 'nosniff')
      // Monaco's AMD loader starts language workers from a bootstrap Blob and
      // then imports the real worker module from this custom scheme. Chromium
      // therefore performs a CORS resource check even though both ultimately
      // belong to the local VEE renderer. These files are immutable bundled
      // assets and never carry credentials, so an explicit public read policy
      // is both safe and required for workers under vee-app://.
      headers.set('Access-Control-Allow-Origin', '*')
      headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
      return new Response(response.body, { status: response.status, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function assertTrustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents ||
      event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== APP_URL) {
    throw new Error('Desktop request denied')
  }
}

// Future AI/deployment handlers must use this boundary and expose only named operations in preload.
function registerTrustedHandler(channel, handler) {
  ipcMain.handle(channel, async (event, ...arguments_) => {
    assertTrustedSender(event)
    return handler(...arguments_)
  })
}

function installWorkspaceHandlers(store) {
  registerTrustedHandler('vee:mode:status', () => ({ offlineMode, onlineServiceConnected: Boolean(onlineService?.status().connected) }))
  registerTrustedHandler('vee:mode:set', enabled => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid offline mode setting')
    if (enabled && agentConnection?.isBusy()) throw new Error('Wait for the current Windows Agent operation to finish before entering Offline Mode')
    offlineMode = enabled
    if (offlineMode) { aiAbortController?.abort(); agentConnection?.clearReviews(); onlineService?.cancel() }
    return { offlineMode, onlineServiceConnected: Boolean(onlineService?.status().connected) }
  })
  registerTrustedHandler('vee:projects:list', () => store.listProjects())
  registerTrustedHandler('vee:projects:starters', () => store.listStarters())
  registerTrustedHandler('vee:projects:create', input => store.createProject(input))
  registerTrustedHandler('vee:projects:open-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open a local website project',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return store.registerFolder(result.filePaths[0])
  })
  registerTrustedHandler('vee:files:list', projectId => store.listFiles(projectId))
  registerTrustedHandler('vee:files:read', (projectId, relativePath) => store.readFile(projectId, relativePath))
  registerTrustedHandler('vee:files:create', (projectId, relativePath) => store.createFile(projectId, relativePath))
  registerTrustedHandler('vee:folders:create', (projectId, relativePath) => store.createDirectory(projectId, relativePath))
  registerTrustedHandler('vee:files:write', (projectId, relativePath, content, expectedContent) => store.writeFile(projectId, relativePath, content, expectedContent))
}

function requireWindowsSecretProtection() {
  if (process.platform !== 'win32' || !safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows credential encryption is unavailable; AI key storage is disabled')
  }
}

function loadAIModule() {
  try {
    return require(AI_RUNTIME)
  } catch {
    throw new Error('The desktop AI gateway has not been built')
  }
}

function aiConfigPath() {
  return path.join(app.getPath('userData'), 'ai', 'provider.json')
}

async function readAIConfig() {
  let raw
  try {
    raw = await fs.readFile(aiConfigPath(), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error('Could not read AI settings')
  }
  try {
    if (raw.length > 20_000) throw new Error('oversized')
    const config = JSON.parse(raw)
    if (!config || !['zai', 'custom'].includes(config.provider) ||
        typeof config.endpoint !== 'string' || typeof config.model !== 'string' ||
        (config.encryptedKey !== null && typeof config.encryptedKey !== 'string')) throw new Error('invalid')
    return config
  } catch {
    throw new Error('AI settings are invalid')
  }
}

async function writeAIConfig(config) {
  const destination = aiConfigPath()
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(config), { flag: 'wx', mode: 0o600 })
    await fs.rename(temporary, destination)
  } catch {
    await fs.unlink(temporary).catch(() => {})
    throw new Error('Could not save AI settings')
  }
}

function providerConfig(config) {
  const ai = loadAIModule()
  const secretRef = 'local-windows-credential'
  const provider = config.provider === 'zai'
    ? ai.createZaiProviderConfig({ model: config.model, secretRef })
    : { id: 'custom', kind: 'openai-compatible', displayName: 'Custom compatible API',
        model: config.model, endpoint: config.endpoint, secretRef }
  ai.validateAIEndpoint(provider)
  if (provider.endpoint !== config.endpoint) throw new Error('AI endpoint does not match provider settings')
  const hostname = new URL(provider.endpoint).hostname.toLowerCase()
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') {
    throw new Error('Loopback AI endpoints are not available in this desktop flow')
  }
  return { ai, provider }
}

function cleanAISettings(input, previous) {
  if (!input || typeof input !== 'object') throw new Error('AI settings are required')
  const provider = input.provider
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  const endpoint = provider === 'zai'
    ? loadAIModule().ZAI_CHAT_COMPLETIONS_ENDPOINT
    : typeof input.endpoint === 'string' ? input.endpoint.trim() : ''
  if (!['zai', 'custom'].includes(provider) || !model || model.length > 120 ||
      !/^[A-Za-z0-9._:/-]+$/.test(model) || endpoint.length > 500) {
    throw new Error('Enter a valid AI provider and model')
  }
  const key = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
  if (key && (key.length < 8 || key.length > 4096)) throw new Error('Enter a valid API key')
  if (!key && (!previous?.encryptedKey || previous.provider !== provider || previous.endpoint !== endpoint)) {
    throw new Error('A new API key is required when the provider or endpoint changes')
  }
  const config = { provider, model, endpoint, encryptedKey: previous?.encryptedKey || null }
  providerConfig(config)
  return { config, key }
}

function installAIHandlers(store) {
  registerTrustedHandler('vee:ai:status', async () => {
    const config = await readAIConfig()
    return { provider: config?.provider || 'zai', model: config?.model || '',
      endpoint: config?.endpoint || '', hasKey: Boolean(config?.encryptedKey),
      keyStorageAvailable: process.platform === 'win32' && safeStorage.isEncryptionAvailable() }
  })
  registerTrustedHandler('vee:ai:save', async input => {
    requireWindowsSecretProtection()
    const previous = await readAIConfig()
    const { config, key } = cleanAISettings(input, previous)
    if (key) {
      try { config.encryptedKey = safeStorage.encryptString(key).toString('base64') }
      catch { throw new Error('Could not encrypt the AI key with Windows') }
    }
    await writeAIConfig(config)
    return { provider: config.provider, model: config.model, endpoint: config.endpoint,
      hasKey: true, keyStorageAvailable: true }
  })
  registerTrustedHandler('vee:ai:remove-key', async () => {
    const config = await readAIConfig()
    if (!config) return { hasKey: false }
    await writeAIConfig({ ...config, encryptedKey: null })
    return { hasKey: false }
  })
  registerTrustedHandler('vee:ai:generate', async input => {
    if (offlineMode) throw new Error('Turn off Offline Mode to send an AI request to your provider')
    requireWindowsSecretProtection()
    if (aiRequestInFlight) throw new Error('An AI request is already in progress')
    if (!input || typeof input !== 'object' || typeof input.projectId !== 'string' ||
        typeof input.path !== 'string' || typeof input.instruction !== 'string' ||
        !input.instruction.trim() || input.instruction.length > MAX_AI_INSTRUCTION_CHARS) {
      throw new Error('Choose a file and enter a short AI instruction')
    }
    aiRequestInFlight = true
    const controller = new AbortController()
    aiAbortController = controller
    try {
      const config = await readAIConfig()
      if (!config?.encryptedKey) throw new Error('Add an AI provider key first')
      const filename = path.posix.basename(input.path).toLowerCase()
      if (filename === '.env' || filename.startsWith('.env.') ||
          /^(id_rsa|id_ed25519|.*\.(pem|p12|pfx|key))$/.test(filename)) {
        throw new Error('Credential files cannot be sent to an AI provider')
      }
      const { ai, provider } = providerConfig(config)
      const source = await store.readFile(input.projectId, input.path)
      if (source.content.length > MAX_AI_SOURCE_CHARS) {
        throw new Error('This file is too large for the AI editing flow')
      }
      const gateway = ai.createAIGateway({
        providers: [provider],
        secretStore: { async getSecret() {
          try { return safeStorage.decryptString(Buffer.from(config.encryptedKey, 'base64')) }
          catch { return null }
        } },
      })
      const proposal = await gateway.generate({
        providerId: provider.id,
        messages: [
          { role: 'system', content: 'You edit one website source file. Return only the complete replacement file contents as plain text. Do not include markdown fences. Do not suggest shell commands or tool calls.' },
          { role: 'user', content: `File: ${input.path}\nInstruction: ${input.instruction.trim()}\n\nCurrent file:\n${source.content}` },
        ],
        maxOutputTokens: 8192,
        signal: controller.signal,
      })
      if (Buffer.byteLength(proposal.text, 'utf8') > MAX_AI_PROPOSAL_BYTES) {
        throw new Error('AI proposal is too large to review safely')
      }
      return proposal
    } finally {
      aiRequestInFlight = false
      aiAbortController = null
    }
  })
}

async function start() {
  app.setAppUserModelId('com.pysnake.visual-enigma-editor')
  await fs.access(path.join(RENDERER_ROOT, 'index.html'))
  await fs.access(path.join(RENDERER_ROOT, 'monaco', 'vs', 'loader.js'))
  installRendererProtocol()
  const store = new WorkspaceStore(app.getPath('userData'))
  installWorkspaceHandlers(store)
  installAIHandlers(store)
  onlineService = await registerOnlineServiceIpc({
    registerTrustedHandler, app, dialog,
    getWindow: () => mainWindow,
    isOnline: () => !offlineMode,
  })
  agentConnection = registerAgentConnectionIpc({
    registerTrustedHandler, safeStorage, app,
    getWorkspaceRoot: async projectId => (await store.project(projectId)).root,
    isOnline: () => !offlineMode,
  })
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, decision) => decision(false))
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 920, minHeight: 650,
    title: 'Visual Enigma Editor',
    icon: path.join(RENDERER_ROOT, 'branding', 'vee-icon.ico'),
    backgroundColor: '#191b1d',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== APP_URL) event.preventDefault()
  })
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault())
  mainWindow.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      title: 'Unsaved changes',
      message: 'Discard unsaved changes and close VEE?',
      buttons: ['Keep editing', 'Discard and close'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (choice === 1) event.preventDefault()
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())
  await mainWindow.loadURL(APP_URL)
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('VEE desktop could not start',
      `The desktop renderer is missing or invalid. Build the desktop frontend first.\n\n${error.message}`)
    app.quit()
  })
} else {
  app.quit()
}
app.on('window-all-closed', () => app.quit())
