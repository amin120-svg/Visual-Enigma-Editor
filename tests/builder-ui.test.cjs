'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { createRequire } = require('node:module')
const frontend = path.resolve(__dirname, '../../VEE-php/frontend')
const frontendRequire = createRequire(path.join(frontend, 'package.json'))
const esbuild = createRequire(frontendRequire.resolve('vite'))('esbuild')

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function startBrowser(profile) {
  const candidates = [process.env.VEE_TEST_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean)
  let executable
  for (const candidate of candidates) {
    if (await fs.access(candidate).then(() => true, () => false)) { executable = candidate; break }
  }
  if (!executable) return null
  const child = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--window-size=1800,1100', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Browser did not start: ${stderr.slice(-500)}`)), 15000)
    child.once('error', reject)
    child.stderr.on('data', chunk => {
      stderr += chunk
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Browser exited: ${code}`)) })
  })
  return { child, endpoint }
}

async function connect(endpoint) {
  const socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Browser debugging connection timed out')) }, 5000)
    socket.onopen = () => { clearTimeout(timer); resolve() }
    socket.onerror = error => { clearTimeout(timer); reject(error) }
  })
  const pending = new Map()
  const events = []
  let sequence = 0
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (!message.id) { events.push(message); return }
    const waiting = pending.get(message.id)
    if (!waiting) return
    pending.delete(message.id)
    if (message.error) waiting.reject(new Error(message.error.message))
    else waiting.resolve(message.result)
  })
  return {
    socket,
    events,
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 10000)
        pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      })
    },
  }
}

test('real builder toolbar, undo, SEO and physical left/right alignment work in Chromium', { timeout: 60000 }, async context => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'vee-builder-browser-'))
  let browser, cdp
  try {
    process.stderr.write('Builder UI: starting an isolated browser\n')
    browser = await startBrowser(profile)
    if (!browser) { context.skip('No local Chromium browser is installed'); return }
    cdp = await connect(browser.endpoint)
    process.stderr.write('Builder UI: browser debugging connected\n')
    const { targetInfos } = await cdp.send('Target.getTargets')
    const target = targetInfos.find(item => item.type === 'page')
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    const send = (method, params) => cdp.send(method, params, sessionId)
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description)
      return result.result.value
    }
    const waitFor = async expression => {
      const until = Date.now() + 10000
      while (Date.now() < until) { if (await evaluate(expression)) return; await delay(40) }
      const diagnostic = await evaluate('document.body.innerText.slice(0,1000)').catch(() => '')
      const exceptions = cdp.events.filter(event => event.method === 'Runtime.exceptionThrown').map(event => event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text)
      throw new Error(`UI timed out: ${expression}\n${diagnostic}\n${exceptions.join('\n')}`)
    }
    const click = async selector => {
      assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), true, selector)
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
      await delay(50)
    }
    const setValue = async (selector, value) => {
      await evaluate(`(() => { const field=document.querySelector(${JSON.stringify(selector)}); const owner=field.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(owner,'value').set.call(field,${JSON.stringify(value)}); field.dispatchEvent(new Event('input',{bubbles:true})); })()`)
      await delay(50)
    }
    await send('Network.enable')
    await send('Runtime.enable')
    await send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] })
    await send('Page.enable')
    await send('Page.bringToFront')
    await send('Page.navigate', { url: 'data:text/html,<html><body><div id="root"></div></body></html>' })
    await waitFor('Boolean(document.getElementById("root"))')
    const build = await esbuild.build({ entryPoints: [path.join(__dirname, 'builder-ui-fixture.tsx')],
      bundle: true, write: false, outdir: profile, format: 'iife', platform: 'browser', target: 'chrome120',
      nodePaths: [path.join(frontend, 'node_modules')], jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"VITE_API_BASE":"/api","BASE_URL":"/"}' },
      logLevel: 'silent',
    })
    process.stderr.write('Builder UI: fixture bundled\n')
    const javascript = build.outputFiles.find(file => file.path.endsWith('.js')).text
    const css = build.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n')
    await evaluate(`(() => { const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);const script=document.createElement('script');script.textContent=${JSON.stringify(javascript)};document.body.append(script); })()`)
    await waitFor('document.querySelector("#builder-body-text")?.value === "Alpha beta gamma"')
    process.stderr.write('Builder UI: editor mounted\n')
    assert.equal(await evaluate('Boolean(document.querySelector(".builder-starters"))'), false, 'Saved content never offers replacement presets')

    await evaluate('document.querySelector("#builder-body-text").focus();document.querySelector("#builder-body-text").setSelectionRange(6,10)')
    await click('[aria-label="Bold"]')
    assert.equal(await evaluate('document.querySelector("#builder-body-text").value'), 'Alpha **beta** gamma')
    await waitFor('document.querySelector("#builder-body-text").value.slice(document.querySelector("#builder-body-text").selectionStart,document.querySelector("#builder-body-text").selectionEnd) === "beta"')
    await click('[title="Undo"]')
    assert.equal(await evaluate('document.querySelector("#builder-body-text").value'), 'Alpha beta gamma')
    await click('[title="Redo"]')
    assert.equal(await evaluate('document.querySelector("#builder-body-text").value'), 'Alpha **beta** gamma')
    await click('[title="Undo"]')

    await evaluate('document.querySelector("#builder-body-text").focus();document.querySelector("#builder-body-text").setSelectionRange(6,10)')
    await click('[aria-label="Underline"]')
    assert.equal(await evaluate('document.querySelector("#builder-body-text").value'), 'Alpha ++beta++ gamma')
    await waitFor('document.querySelector(".preview-frame iframe")?.contentDocument?.querySelector("u")?.textContent === "beta"')
    await click('[aria-label="Clear formatting"]')
    assert.equal(await evaluate('document.querySelector("#builder-body-text").value'), 'Alpha beta gamma')
    await evaluate('document.querySelector("#builder-body-text").focus();document.querySelector("#builder-body-text").setSelectionRange(6,10);document.querySelector("#builder-body-text").dispatchEvent(new KeyboardEvent("keydown",{key:"b",ctrlKey:true,bubbles:true,cancelable:true}))')
    assert.equal(await evaluate('document.querySelector("#builder-body-text").value'), 'Alpha **beta** gamma')
    await click('[title="Undo"]')

    await evaluate('document.querySelector("#builder-body-text").setSelectionRange(6,10)')
    await click('[aria-label="Insert link"]')
    await setValue('.builder-link-form input[placeholder]', 'https://example.com/contact')
    await setValue('#builder-body-text', 'Prefix Alpha beta gamma')
    await click('.builder-link-form > div button:first-child')
    assert.equal(await evaluate('document.querySelector("#builder-body-text").value'), 'Prefix Alpha beta gamma')
    assert.match(await evaluate('document.querySelector(".builder-link-form [role=alert]")?.textContent'), /body text changed/)
    await click('.builder-link-form > div button:last-child')

    await evaluate('document.querySelector("#builder-body-text").setSelectionRange(7,12)')
    await click('[aria-label="Insert link"]')
    await setValue('.builder-link-form input[placeholder]', 'https://example.com/contact')
    await click('.builder-link-form > div button:first-child')
    assert.equal(await evaluate('document.querySelector("#builder-body-text").value'), 'Prefix [Alpha](https://example.com/contact) beta gamma')

    await click('#builder-tab-page')
    await evaluate(`(() => {const field=document.querySelector('#builder-panel-page select');field.value='rtl';field.dispatchEvent(new Event('change',{bubbles:true}));})()`)
    await click('[aria-label="Right alignment"]')
    await waitFor('document.querySelector(".preview-frame iframe")?.contentDocument?.body?.style.direction === "rtl"')
    const bounds = async () => evaluate(`(() => {const frame=document.querySelector('.preview-frame iframe');const doc=frame.contentDocument;const heading=doc.querySelector('h1');const parent=heading.parentElement;const h=heading.getBoundingClientRect();const p=parent.getBoundingClientRect();const style=frame.contentWindow.getComputedStyle(parent);return {left:h.left-p.left-parseFloat(style.paddingLeft),right:p.right-h.right-parseFloat(style.paddingRight),align:frame.contentWindow.getComputedStyle(heading).textAlign,direction:frame.contentWindow.getComputedStyle(heading).direction};})()`)
    const right = await bounds()
    assert.equal(right.align, 'right')
    assert.equal(right.direction, 'rtl')
    assert.ok(Math.abs(right.right) < 1, JSON.stringify(right))
    await click('[aria-label="Left alignment"]')
    const left = await bounds()
    assert.equal(left.align, 'left')
    assert.ok(Math.abs(left.left) < 1, JSON.stringify(left))
    await click('[aria-label="Center alignment"]')
    const center = await bounds()
    assert.ok(Math.abs(center.left - center.right) < 1, JSON.stringify(center))

    await click('#builder-tab-seo')
    await setValue('#builder-panel-seo input[maxlength="200"]', 'صفحه آزمایشی')
    await setValue('#builder-panel-seo input[maxlength="64"]', 'fa')
    await setValue('#builder-panel-seo textarea[maxlength="1000"]', 'A useful description')
    await click('.publish-controls button.secondary')
    await waitFor('Boolean(window.builderQA.saved)')
    const saved = await evaluate('window.builderQA.saved')
    assert.equal(saved.seo.title, 'صفحه آزمایشی')
    assert.equal(saved.seo.language, 'fa')
    assert.equal(saved.page.direction, 'rtl')
    assert.equal(saved.page.textAlign, 'center')
    assert.equal(await evaluate('window.builderQA.dirty'), false)
    assert.equal(await evaluate('document.querySelector(".preview-frame iframe").contentDocument.title'), 'صفحه آزمایشی')
    await evaluate('window.startFreshBuilderQA()')
    await waitFor('document.querySelectorAll(".builder-starters > div > button").length === 5')
    assert.equal(await evaluate('window.builderQA.saved'), null)
    await evaluate('Array.from(document.querySelectorAll(".builder-starters button")).find(button=>button.querySelector("strong")?.textContent==="Personal portfolio").click()')
    await waitFor('document.querySelector("#builder-body-text")?.value.startsWith("Introduce yourself")')
    assert.equal(await evaluate('window.builderQA.saved'), null, 'Choosing a preset creates an unsaved draft')
    assert.equal(await evaluate('window.builderQA.dirty'), true)
    await click('.publish-controls button.secondary')
    await waitFor('window.builderQA.saved?.blocks?.length === 5')
    assert.equal(await evaluate('window.builderQA.saved.seo.language'), 'en')
    assert.equal(await evaluate('window.builderQA.saved.page.direction'), 'ltr')
    assert.equal(await evaluate('window.builderQA.saved.page.fontFamily'), 'serif')
    assert.equal(await evaluate('window.builderQA.dirty'), false)
    context.diagnostic('No network requests or production projects were used; body selection, underline, clear formatting, keyboard bold, stale link protection, undo/redo, RTL alignment, SEO save and a new unsaved portfolio draft passed.')
  } finally {
    if (cdp) { await cdp.send('Browser.close').catch(() => {}); cdp.socket.close() }
    if (browser && browser.child.exitCode === null) { await Promise.race([new Promise(resolve => browser.child.once('exit', resolve)), delay(3000)]); if (browser.child.exitCode === null) browser.child.kill() }
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {})
  }
})
