'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto')
const { registerAgentConnectionIpc } = require('../agent-connection.cjs')

function encryptedStorage() {
  const key = randomBytes(32)
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext])
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
    },
  }
}

const settings = {
  host: '127.0.0.1',
  port: 7443,
  domain: 'vee.test',
  remoteRoot: 'C:\\VeeTests\\Managed\\site',
  certificateFingerprint: `SHA256:${'a'.repeat(64)}`,
}

test('IPC boundary protects Agent tokens and exposes busy/offline state without a network call', { skip: process.platform !== 'win32' }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'vee-agent-ipc-'))
  t.after(() => fs.rm(temporary, { recursive: true, force: true }))
  const handlers = new Map()
  let online = true
  let networkCalls = 0
  let releaseStatus
  let statusStarted
  const statusStartedPromise = new Promise(resolve => { statusStarted = resolve })
  const statusPromise = new Promise(resolve => { releaseStatus = resolve })
  const controller = registerAgentConnectionIpc({
    registerTrustedHandler: (name, handler) => handlers.set(name, handler),
    safeStorage: encryptedStorage(),
    app: { getPath: name => { assert.equal(name, 'userData'); return temporary } },
    getWorkspaceRoot: async () => { throw new Error('not used') },
    isOnline: () => online,
    clientFactory: (_transport, credentialStore) => ({
      async pair(target) {
        networkCalls += 1
        await credentialStore.saveCredential(target.id, 'memory-only-test-token-abcdefghijklmnopqrstuvwxyz')
        return { paired: true }
      },
      async request(_target, request) {
        networkCalls += 1
        if (request.operation !== 'status') throw new Error('Unexpected test operation')
        statusStarted()
        await statusPromise
        return { projectIds: [], runtimeKinds: ['static', 'php'], operations: ['status'] }
      },
    }),
  })

  const fresh = await handlers.get('vee:agent:settings')()
  assert.equal(fresh.host, '')
  assert.equal(fresh.paired, false)
  await assert.rejects(() => handlers.get('vee:agent:status')(), /Configure and pair/)
  assert.equal(networkCalls, 0)
  await handlers.get('vee:agent:save-settings')(settings)
  assert.equal((await handlers.get('vee:agent:settings')()).host, settings.host)
  const paired = await handlers.get('vee:agent:pair')({ pairingCode: 'fixture-code', controllerName: 'IPC test' })
  assert.equal(paired.paired, true)
  assert.equal(Object.hasOwn(paired, 'token'), false)
  assert.equal(Object.hasOwn(paired, 'encryptedToken'), false)
  const rawSettings = await fs.readFile(path.join(temporary, 'agent', 'connection.json'), 'utf8')
  assert.equal(rawSettings.includes('memory-only-test-token'), false)
  assert.match(JSON.parse(rawSettings).encryptedToken, /^[A-Za-z0-9+/]+=*$/)

  online = false
  const callsBeforeOffline = networkCalls
  await assert.rejects(() => handlers.get('vee:agent:status')(), /Offline Mode/)
  assert.equal(networkCalls, callsBeforeOffline)

  online = true
  const active = handlers.get('vee:agent:status')()
  await statusStartedPromise
  assert.equal(controller.isBusy(), true)
  await assert.rejects(() => handlers.get('vee:agent:save-settings')(settings), /current Agent operation/)
  releaseStatus()
  assert.equal((await active).connected, true)
  assert.equal(controller.isBusy(), false)

  const disconnected = await handlers.get('vee:agent:disconnect')()
  assert.equal(disconnected.paired, false)
  assert.equal(Object.hasOwn(await handlers.get('vee:agent:settings')(), 'encryptedToken'), false)
})
