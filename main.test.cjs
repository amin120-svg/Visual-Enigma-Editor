'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

async function harness(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vee-main-test-'))
  const handlers = new Map()
  const frame = { url: 'vee-app://app/index.html' }
  const contents = { mainFrame: frame }
  const event = { sender: contents, senderFrame: frame }
  const endpoint = 'https://api.z.ai/api/paas/v4/chat/completions'
  const configuration = JSON.stringify({ provider: 'zai', model: 'fixture-model', endpoint, encryptedKey: 'fixture-encrypted' })
  const ai = {
    ZAI_CHAT_COMPLETIONS_ENDPOINT: endpoint,
    createZaiProviderConfig: input => ({ id: 'zai', endpoint, ...input }),
    validateAIEndpoint: provider => new URL(provider.endpoint),
    createAIGateway: () => ({ generate: options.generate || (async () => ({ text: 'replacement', requiresExplicitApproval: true })) }),
  }
  const nativeRequire = createRequire(__filename)
  const electron = {
    app: { getPath: () => directory, requestSingleInstanceLock: () => true,
      on() {}, quit() {}, whenReady: () => ({ then: () => ({ catch() {} }) }) },
    BrowserWindow: class {},
    dialog: {},
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    net: {}, protocol: { registerSchemesAsPrivileged() {} }, session: {},
    safeStorage: { isEncryptionAvailable: () => true, decryptString: () => 'fixture-secret' },
  }
  const testFs = { ...fs, readFile: async (file, ...arguments_) => {
    if (path.basename(file) === 'provider.json') return options.readConfig ? options.readConfig(configuration) : configuration
    return fs.readFile(file, ...arguments_)
  } }
  const module = { exports: {} }
  const source = await fs.readFile(path.join(__dirname, 'main.cjs'), 'utf8')
  vm.runInNewContext(source + '\nmodule.exports = { installWorkspaceHandlers, installAIHandlers, setWindow: value => { mainWindow = value } };', {
    module, exports: module.exports, __dirname, process: { platform: 'win32' },
    URL, Headers, Response, Buffer, AbortController,
    require: specifier => specifier === 'electron' ? electron : specifier === 'node:fs/promises' ? testFs :
      specifier.endsWith('ai-runtime.cjs') ? ai : nativeRequire(specifier),
  }, { filename: path.join(__dirname, 'main.cjs') })
  module.exports.setWindow({ webContents: contents })
  const store = { readFile: async () => ({ content: '<main>Original</main>' }) }
  module.exports.installWorkspaceHandlers(store)
  module.exports.installAIHandlers(store)
  return {
    invoke: (channel, input, sender = event) => handlers.get(channel)(sender, input),
    dispose: () => fs.rm(directory, { recursive: true, force: true }),
  }
}

test('AI lock is acquired before asynchronous settings reads', async () => {
  let unblock
  let first = true
  const instance = await harness({ readConfig: async configuration => {
    if (first) { first = false; await new Promise(resolve => { unblock = resolve }) }
    return configuration
  } })
  try {
    const input = { projectId: 'fixture', path: 'index.html', instruction: 'Edit the title' }
    const pending = instance.invoke('vee:ai:generate', input)
    await assert.rejects(instance.invoke('vee:ai:generate', input), /already in progress/)
    unblock()
    assert.equal((await pending).text, 'replacement')
    assert.equal((await instance.invoke('vee:ai:generate', input)).text, 'replacement')
  } finally { await instance.dispose() }
})

test('explicit Offline Mode blocks provider requests and preserves local runtime status', async () => {
  const instance = await harness()
  try {
    assert.equal((await instance.invoke('vee:mode:status')).offlineMode, false)
    const status = await instance.invoke('vee:mode:set', true)
    assert.equal(status.offlineMode, true)
    assert.equal(status.onlineServiceConnected, false)
    await assert.rejects(instance.invoke('vee:ai:generate', { projectId: 'fixture', path: 'index.html', instruction: 'Edit' }), /Offline Mode/)
    await assert.rejects(instance.invoke('vee:mode:set', 'true'), /Invalid offline/)
  } finally { await instance.dispose() }
})

test('IPC rejects an untrusted frame and AI rejects credential files', async () => {
  const instance = await harness()
  try {
    await assert.rejects(instance.invoke('vee:mode:status', undefined, { sender: {}, senderFrame: { url: 'https://example.invalid' } }), /denied/)
    await assert.rejects(instance.invoke('vee:ai:generate', { projectId: 'fixture', path: '.env', instruction: 'Edit' }), /Credential files/)
  } finally { await instance.dispose() }
})
