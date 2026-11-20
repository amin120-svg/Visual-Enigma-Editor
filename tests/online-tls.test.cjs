'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const https = require('node:https')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { OnlineService, httpsTransport } = require('../online-service.cjs')

test('actual loopback TLS refuses untrusted certificates, then authenticates with trusted TLS, private cookies and CSRF', async t => {
  const python = process.env.VEE_TEST_PYTHON || (process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe')
    : 'python3')
  // Dynamic test-only key exists in memory for this test, never source or logs.
  const generated = await promisify(execFile)(python, [path.join(__dirname, 'online-tls-fixture.py')], { shell: false, windowsHide: true, timeout: 15000, maxBuffer: 100000 })
  const material = JSON.parse(generated.stdout)
  const calls = []
  const csrf = 's'.repeat(43)
  const user = { id: 'cc4e2259-e6f5-4484-854f-26777c4567e6', email: 'person@example.invalid', displayName: 'Example', role: 'administrator', experienceLevel: 'professional', locale: 'fa', organization: { id: '8ac3fe8e-1126-475d-b701-bd511f1cd01f', name: 'Fixture' } }
  let authenticated = false
  const server = https.createServer(material, (request, response) => {
    calls.push({ route: request.url, headers: request.headers })
    response.setHeader('Content-Type', 'application/json')
    response.setHeader('Set-Cookie', '__Host-vee_session=isolated-tls-session; Path=/; Secure; HttpOnly; SameSite=Lax')
    if (request.url === '/api/session') response.end(JSON.stringify({ csrfToken: csrf, user: authenticated ? user : null, setupRequired: false }))
    else if (request.url === '/api/auth/login') {
      if (request.headers.cookie !== '__Host-vee_session=isolated-tls-session' || request.headers['x-csrf-token'] !== csrf || request.headers.origin !== baseUrl) {
        response.statusCode = 403
        response.end(JSON.stringify({ error: 'Session boundary failed' }))
      } else {
        let bytes = 0
        request.on('data', chunk => { bytes += chunk.length })
        request.on('end', () => { authenticated = bytes > 0; response.end(JSON.stringify({ ok: true })) })
      }
    } else if (request.url === '/api/redirect') {
      response.statusCode = 302
      response.setHeader('Location', `${baseUrl}/api/should-not-be-called`)
      response.end('{}')
    } else if (request.url === '/api/large') response.end('x'.repeat(4096))
    else { response.statusCode = 404; response.end('{}') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `https://127.0.0.1:${server.address().port}`
  t.after(() => { server.closeAllConnections(); server.close() })

  const service = new OnlineService({})
  await assert.rejects(service.connect(baseUrl), /unavailable/)
  assert.equal(calls.length, 0, 'HTTP credentials cannot be sent over an untrusted TLS connection')

  const originalAgent = https.globalAgent
  https.globalAgent = new https.Agent({ ca: material.cert, keepAlive: false })
  t.after(() => { https.globalAgent.destroy(); https.globalAgent = originalAgent })
  const connected = await service.connect(baseUrl)
  assert.equal(connected.authenticated, false)
  const loggedIn = await service.login({ email: user.email, password: require('node:crypto').randomBytes(24).toString('base64url') })
  assert.equal(loggedIn.authenticated, true)
  assert.equal(loggedIn.user.experienceLevel, 'professional')
  assert.equal(JSON.stringify(loggedIn).includes('isolated-tls-session'), false)
  await assert.rejects(service.request('redirect'), /redirected/)
  assert.equal(calls.some(call => call.route.includes('should-not-be-called')), false)
  await assert.rejects(httpsTransport({ url: `${baseUrl}/api/large`, method: 'GET', headers: {}, signal: new AbortController().signal, maxBytes: 1024 }), /size limit/)
})
