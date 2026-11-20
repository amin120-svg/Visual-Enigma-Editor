'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const frontend = path.resolve(__dirname, '../../VEE-php/frontend')
const ts = createRequire(path.join(frontend, 'package.json'))('typescript')

function loadTypeScript(filename, dependencies = {}) {
  const source = fs.readFileSync(path.join(frontend, 'src', filename), 'utf8')
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  new vm.Script(`(function(require,module,exports){${javascript}})`, { filename })
    .runInThisContext()(specifier => {
      if (!(specifier in dependencies)) throw new Error(`Unexpected runtime dependency: ${specifier}`)
      return dependencies[specifier]
    }, module, module.exports)
  return module.exports
}

const rendering = loadTypeScript('builder/document.ts')
const builder = loadTypeScript('desktop/local-builder-store.ts', { '../builder/document': rendering })
const { BUILDER_STARTERS } = loadTypeScript('builder/starter-layouts.ts', { './document': rendering })
const document = { version: 1, blocks: [{ id: 'hero-1', type: 'hero', title: '<script>alert(1)</script>', body: 'A & B' }] }

function memoryWorkspace() {
  const files = new Map()
  const writes = []
  return { files, writes, bridge: {
    listFiles: async () => ({ items: [...files.keys()].map(path => ({ path, type: 'file' })), truncated: false }),
    readFile: async (_projectId, path) => ({ path, content: files.get(path) }),
    createDirectory: async () => {},
    createFile: async (_projectId, path) => {
      if (files.has(path)) throw new Error('File already exists')
      files.set(path, '')
    },
    writeFile: async (_projectId, path, content, expectedContent) => {
      if (expectedContent !== undefined && files.get(path) !== expectedContent) throw new Error('File changed on disk')
      files.set(path, content); writes.push(path)
      return { path, bytes: Buffer.byteLength(content) }
    },
  } }
}

test('block text cannot become executable markup', () => {
  const html = rendering.previewHtml(document)
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(html.includes('A &amp; B'))
  assert.ok(!html.includes('<script>'))
})

test('unsupported or ambiguous metadata is preserved by refusing conversion', () => {
  for (const value of [
    { version: 2, blocks: [] },
    { ...document, extra: true },
    { version: 1, blocks: [...document.blocks, ...document.blocks] },
    { version: 1, blocks: [{ ...document.blocks[0], type: 'unknown' }] },
  ]) assert.throws(() => builder.validateLocalBuilder(value))
})

test('local saves use only generated paths and refuse concurrent source changes', async () => {
  const { bridge, files, writes } = memoryWorkspace()
  const storage = builder.localBuilderStorage(bridge)
  assert.deepEqual(await storage.load('project'), { version: 1, blocks: [], page: { direction: 'ltr' }, seo: { language: 'en' } })
  assert.equal(storage.isNewDocument('project'), true)
  await storage.save('project', document)
  assert.equal(storage.isNewDocument('project'), false)
  assert.deepEqual(writes, ['visual-builder/vee.builder.json', 'visual-builder/preview.html'])
  files.set('visual-builder/vee.builder.json', 'external source change')
  await assert.rejects(() => storage.save('project', document), /changed/)
  assert.equal(files.get('visual-builder/vee.builder.json'), 'external source change')
})

test('truncated listings and oversized output cause no writes', async () => {
  const { bridge, writes } = memoryWorkspace()
  const truncated = builder.localBuilderStorage({ ...bridge, listFiles: async () => ({ items: [], truncated: true }) })
  await assert.rejects(() => truncated.load('project'), /too large/)
  const storage = builder.localBuilderStorage(bridge)
  await storage.load('project')
  const huge = { version: 1, blocks: Array.from({ length: 100 }, (_, index) => ({
    id: `hero-${index}`, type: 'hero', title: 'Hero', body: '<'.repeat(10_000),
  })) }
  await assert.rejects(() => storage.save('project', huge), /2 MB/)
  assert.equal(writes.length, 0)
})

test('legacy metadata is unchanged and optional page controls roundtrip through save and reload', async () => {
  assert.equal(JSON.stringify(builder.validateLocalBuilder(document)), JSON.stringify(document))
  const rich = { ...document, page: { backgroundColor: '#123456', textColor: '#ffffff', textAlign: 'center', direction: 'rtl' },
    seo: { title: 'A Persian page', description: 'Description & details', language: 'fa', canonicalUrl: 'https://example.com/page', robots: 'index,follow', ogImage: 'https://example.com/share.png' },
    blocks: [{ ...document.blocks[0], backgroundColor: '#223344', textAlign: 'right', direction: 'rtl', headingLevel: 3, bodyFormat: 'formatted', body: '**سلام**\n- یک\n- دو\n\n[Contact](/contact)' }] }
  const { bridge, files } = memoryWorkspace()
  const storage = builder.localBuilderStorage(bridge)
  await storage.load('project'); await storage.save('project', rich)
  assert.equal(JSON.stringify(await storage.load('project')), JSON.stringify(rich))
  const html = files.get('visual-builder/preview.html')
  for (const expected of ['lang="fa" dir="rtl"', 'background:#123456', 'text-align:center', '<h3>', '<strong>سلام</strong>', '<ul><li>یک</li><li>دو</li></ul>', 'href="/contact"', '<link rel="canonical"', 'property="og:image"']) assert.ok(html.includes(expected), expected)
})

test('colors, metadata URLs, headings and unknown fields cannot inject HTML or CSS', () => {
  for (const patch of [
    { page: { backgroundColor: '#ffffff;background:url(https://bad.example)' } },
    { page: { textAlign: 'center;display:none' } },
    { page: { backgroundColor: '#123456\n' } },
    { seo: { canonicalUrl: 'javascript:alert(1)' } },
    { seo: { ogImage: 'data:image/svg+xml,bad' } },
    { seo: { canonicalUrl: 'https://user:private@example.com' } },
    { seo: { language: 'fa" onclick="bad' } },
    { seo: { language: 'fa\n' } },
    { seo: { robots: 'anything' } },
    { seo: { unexpected: true } },
    { seo: { constructor: 'unexpected' } },
    { seo: JSON.parse('{"__proto__":"unexpected"}') },
    { blocks: [{ ...document.blocks[0], headingLevel: '1 onmouseover=bad' }] },
  ]) assert.throws(() => builder.validateLocalBuilder({ ...document, ...patch }))
  const html = rendering.previewHtml({ ...document, page: { backgroundColor: 'url(https://bad.example)', textAlign: 'x" onmouseover="bad' }, seo: { title: '</title><script>bad</script>', canonicalUrl: 'javascript:alert(1)', ogImage: 'data:bad' } })
  assert.ok(!html.includes('<script>'))
  assert.ok(!html.includes('url(https://bad.example)'))
  assert.ok(!html.includes('href="javascript:'))
  assert.ok(!html.includes('content="data:'))
})

test('formatted text escapes markup and allows only safe links', () => {
  const html = rendering.formattedBody('**<img src=x onerror=bad>** *text*\n\n[bad](javascript:alert%281%29) [data](data:text/html,bad) [protocol](//bad.example) [ok](https://example.com/?a=1&b=2)\n\n1. First\n2. Second')
  assert.ok(html.includes('<strong>&lt;img'))
  assert.ok(html.includes('<em>text</em>'))
  assert.ok(html.includes('<ol><li>First</li><li>Second</li></ol>'))
  assert.ok(html.includes('href="https://example.com/?a=1&amp;b=2"'))
  assert.ok(!html.includes('<img'))
  assert.ok(!html.includes('href="javascript:'))
  assert.ok(!html.includes('href="data:'))
  assert.ok(!html.includes('href="//'))
  assert.equal(rendering.safeLinkUrl('https://example.com\\@bad.example'), false)
  assert.equal(rendering.safeLinkUrl('mailto:contact@example.com'), true)
  assert.equal(rendering.safeLinkUrl('#contact'), true)
  assert.ok(rendering.seoChecks({ version: 1, blocks: [] }).some(check => !check.good))
})

test('professional formatting stays escaped, supports quotations and nested emphasis', () => {
  const html = rendering.formattedBody('++Underlined++ ~~Removed~~ ==Noted== `<img src=x>` **A *nested* example**\n\n> A **quotation**\n> Another line\n\n[bad](javascript:alert%281%29)')
  for (const fragment of ['<u>Underlined</u>', '<s>Removed</s>', '<mark>Noted</mark>', '<code>&lt;img src=x&gt;</code>', '<strong>A <em>nested</em> example</strong>', '<blockquote>A <strong>quotation</strong><br>Another line</blockquote>']) assert.ok(html.includes(fragment), fragment)
  assert.ok(!html.includes('<img'))
  assert.ok(!html.includes('href="javascript:'))
})

test('writing selection commands toggle formatting and respect selected line boundaries', () => {
  for (const [action, marker] of [['bold', '**'], ['italic', '*'], ['underline', '++'], ['strike', '~~'], ['code', '`'], ['highlight', '==']]) {
    const applied = rendering.editWritingSelection('before word after', 7, 11, action)
    assert.equal(applied.body, `before ${marker}word${marker} after`)
    const removed = rendering.editWritingSelection(applied.body, applied.start, applied.end, action)
    assert.equal(removed.body, 'before word after')
    assert.equal(removed.body.slice(removed.start, removed.end), 'word')
  }
  assert.equal(rendering.editWritingSelection('one\ntwo\nthree', 0, 4, 'number').body, '1. one\ntwo\nthree')
  const quote = rendering.editWritingSelection('one\ntwo', 0, 7, 'quote')
  assert.equal(quote.body, '> one\n> two')
  assert.equal(rendering.editWritingSelection(quote.body, quote.start, quote.end, 'quote').body, 'one\ntwo')
  const clear = rendering.editWritingSelection('**Bold**\n- ++Underlined++\n\n> [Contact](/contact)', 0, 0, 'clear')
  assert.equal(clear.body, 'Bold\nUnderlined\n\nContact')
  const within = rendering.editWritingSelection('before **word** after', 9, 13, 'clear')
  assert.equal(within.body, 'before word after')
})

test('typography roundtrips and rejects strings, nonfinite values and unsafe style input', async () => {
  const rich = { ...document, page: { fontFamily: 'serif', bodyFontSize: 19, lineHeight: 1.85, letterSpacing: 0.2, textAlign: 'justify' }, blocks: [{ ...document.blocks[0], fontFamily: 'monospace', bodyFontSize: 15 }] }
  const { bridge, files } = memoryWorkspace()
  const storage = builder.localBuilderStorage(bridge)
  await storage.load('project'); await storage.save('project', rich)
  assert.deepEqual(await storage.load('project'), rich)
  const html = files.get('visual-builder/preview.html')
  for (const fragment of ['font-family:Georgia,serif', '--vee-body-size:19px', '--vee-leading:1.85', '--vee-tracking:0.2px', 'text-align:justify', 'font-family:ui-monospace,monospace']) assert.ok(html.includes(fragment), fragment)
  for (const page of [{ fontFamily: 'url(https://bad.example)' }, { fontFamily: '__proto__' }, { bodyFontSize: '20' }, { bodyFontSize: NaN }, { bodyFontSize: Infinity }, { bodyFontSize: 41 }, { lineHeight: 0 }, { letterSpacing: -2 }, { letterSpacing: '0;color:red' }]) assert.throws(() => builder.validateLocalBuilder({ ...document, page }))
})

test('initial page layouts create English drafts without overwriting existing builder documents', async () => {
  assert.equal(BUILDER_STARTERS.length, 5)
  const { bridge, files, writes } = memoryWorkspace()
  files.set('index.html', 'Original user website')
  const storage = builder.localBuilderStorage(bridge)
  await storage.load('project')
  assert.equal(storage.isNewDocument('project'), true)
  for (const starter of BUILDER_STARTERS) {
    const a = builder.validateLocalBuilder(starter.create()); const b = starter.create()
    assert.equal(a.page.direction, 'ltr'); assert.equal(a.seo.language, 'en')
    assert.equal(new Set(a.blocks.map(block => block.id)).size, a.blocks.length)
    if (a.blocks.length) { assert.notEqual(a.blocks[0].id, b.blocks[0].id); assert.ok(rendering.previewHtml(a).includes(a.blocks[0].title.replace(/&/g, '&amp;'))) }
  }
  assert.equal(writes.length, 0, 'Browsing/creating in-memory layouts does not write files')
  files.set('visual-builder/vee.builder.json', JSON.stringify({ version: 1, blocks: [], page: { direction: 'rtl' }, seo: { language: 'fa' } }))
  const existing = await storage.load('project')
  assert.equal(existing.page.direction, 'rtl'); assert.equal(existing.seo.language, 'fa')
  assert.equal(storage.isNewDocument('project'), false, 'An intentionally empty saved draft is not a new document')
  assert.equal(files.get('index.html'), 'Original user website')
})
