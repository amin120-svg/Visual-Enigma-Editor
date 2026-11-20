'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { WorkspaceStore } = require('./workspace.cjs')

async function withStore(action) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'vee-desktop-test-'))
  try { await action(new WorkspaceStore(temporary), temporary) }
  finally { await fs.rm(temporary, { recursive: true, force: true }) }
}

test('creates a local project and saves text without a server', async () => {
  await withStore(async store => {
    const project = await store.createProject({ name: 'My Website' })
    assert.equal((await store.listProjects()).length, 1)
    assert.match((await store.readFile(project.id, 'index.html')).content, /My Website/)
    await store.writeFile(project.id, 'styles.css', 'body { color: green; }\n')
    assert.equal((await store.readFile(project.id, 'styles.css')).content, 'body { color: green; }\n')
    await assert.rejects(store.createFile(project.id, 'styles.css'))
    assert.equal((await store.readFile(project.id, 'styles.css')).content, 'body { color: green; }\n')
  })
})

test('rejects traversal, alternate streams, and cross-project identifiers', async () => {
  await withStore(async store => {
    const first = await store.createProject({ name: 'First' })
    const second = await store.createProject({ name: 'Second' })
    for (const malicious of ['../projects.json', '/etc/passwd', 'C:/Windows/win.ini', 'folder\\file.txt', 'file.txt:secret', 'CON.txt']) {
      await assert.rejects(store.writeFile(first.id, malicious, 'unsafe'))
    }
    await assert.rejects(store.readFile('missing-project', 'index.html'))
    assert.notEqual(first.id, second.id)
    assert.match((await store.readFile(second.id, 'index.html')).content, /Second/)
  })
})

test('rejects large text and binary files', async () => {
  await withStore(async store => {
    const project = await store.createProject({ name: 'Limits' })
    await assert.rejects(store.writeFile(project.id, 'large.txt', 'x'.repeat(2 * 1024 * 1024 + 1)))
    await fs.writeFile(path.join(project.root, 'binary.dat'), Buffer.from([0, 1, 2]))
    await assert.rejects(store.readFile(project.id, 'binary.dat'))
  })
})

test('concurrent project creation does not lose registry entries', async () => {
  await withStore(async store => {
    const created = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      store.createProject({ name: `Project ${index}` })))
    assert.equal(new Set(created.map(project => project.id)).size, 12)
    assert.equal((await store.listProjects()).length, 12)
  })
})

test('a stale editor snapshot does not overwrite changes on disk', async () => {
  await withStore(async store => {
    const project = await store.createProject({ name: 'Conflict' })
    const original = (await store.readFile(project.id, 'styles.css')).content
    await store.writeFile(project.id, 'styles.css', 'body { color: blue; }')
    await assert.rejects(store.writeFile(project.id, 'styles.css', 'body { color: red; }', original), /changed on disk/)
    assert.equal((await store.readFile(project.id, 'styles.css')).content, 'body { color: blue; }')
  })
})

test('concurrent writes with the same snapshot cannot silently replace one another', async () => {
  await withStore(async store => {
    const project = await store.createProject({ name: 'Concurrent saves' })
    const original = (await store.readFile(project.id, 'styles.css')).content
    const results = await Promise.allSettled([
      store.writeFile(project.id, 'styles.css', 'first replacement', original),
      store.writeFile(project.id, 'styles.css', 'second replacement', original),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal((await store.readFile(project.id, 'styles.css')).content, 'first replacement')
  })
})

test('creates a scoped builder folder while rejecting invalid folders', async () => {
  await withStore(async store => {
    const project = await store.createProject({ name: 'Builder' })
    await store.createDirectory(project.id, 'visual-builder')
    await store.createDirectory(project.id, 'visual-builder')
    await store.writeFile(project.id, 'visual-builder/vee.builder.json', '{"version":1,"blocks":[]}')
    assert.equal((await store.readFile(project.id, 'visual-builder/vee.builder.json')).content, '{"version":1,"blocks":[]}')
    await assert.rejects(store.createDirectory(project.id, '../outside'))
    await assert.rejects(store.createDirectory(project.id, 'styles.css'))
  })
})

test('each advertised starter creates real, editable English source files', async () => {
  await withStore(async store => {
    const starters = store.listStarters()
    assert.equal(new Set(starters.map(item => item.id)).size, starters.length)
    assert.ok(starters.length > 8)
    for (const starter of starters) {
      const project = await store.createProject({ name: 'Source & Studio', starterId: starter.id })
      assert.equal(project.entryFile, starter.entryFile)
      assert.equal(project.starterId, starter.id)
      const entry = await store.readFile(project.id, project.entryFile)
      assert.ok(entry.content.length > 0)
      const listed = await store.listFiles(project.id)
      const names = listed.items.filter(item => item.type === 'file').map(item => item.path)
      assert.ok(names.includes('README.md'))
      for (const filename of names.filter(name => name.endsWith('.html'))) {
        const html = (await store.readFile(project.id, filename)).content
        assert.match(html, /<html lang="en" dir="ltr">/)
        for (const match of html.matchAll(/(?:href|src)="([^"{}]+\.(?:css|js))"/g)) {
          if (match[1].startsWith('/')) continue
          const dependency = path.posix.join(path.posix.dirname(filename), match[1])
          assert.ok(names.includes(dependency), `${starter.id} is missing ${dependency}`)
        }
      }
      for (const filename of names.filter(name => name.endsWith('.json'))) {
        assert.doesNotThrow(() => JSON.parse(require('node:fs').readFileSync(path.join(project.root, filename), 'utf8')))
      }
      await store.writeFile(project.id, project.entryFile, `${entry.content}\n`, entry.content)
      assert.equal((await store.readFile(project.id, project.entryFile)).content, `${entry.content}\n`)
    }
    assert.equal((await store.listProjects()).length, starters.length)
  })
})

test('blank project adds no executable source and invalid starters create no folders', async () => {
  await withStore(async (store, temporary) => {
    for (const starterId of ['../outside', 'constructor', '__proto__', {}, null]) {
      if (starterId === null) continue // Omitted/null chooses the compatible default.
      await assert.rejects(store.createProject({ name: 'Invalid', starterId }), /supported project starter/)
    }
    assert.equal((await store.listProjects()).length, 0)
    assert.deepEqual(await fs.readdir(temporary), [])
    const project = await store.createProject({ name: 'Clean', starterId: 'blank' })
    assert.deepEqual((await store.listFiles(project.id)).items.map(item => item.path), ['README.md'])
  })
})

test('failed starter registration removes only its new workspace and preserves existing sources', async () => {
  await withStore(async store => {
    const existing = await store.createProject({ name: 'Keep this source' })
    const original = (await store.readFile(existing.id, 'index.html')).content
    const writeRegistry = store.writeRegistry
    store.writeRegistry = async () => { throw new Error('Simulated registry write failure') }
    await assert.rejects(store.createProject({ name: 'Fail safely', starterId: 'vue' }), /registry write failure/)
    store.writeRegistry = writeRegistry
    assert.deepEqual(await fs.readdir(store.projectDirectory), [existing.id])
    assert.equal((await store.readFile(existing.id, 'index.html')).content, original)
    assert.equal((await store.listProjects()).length, 1)
  })
})

test('project names remain data in generated HTML, components, and PHP', async () => {
  await withStore(async store => {
    const name = 'Studio </script> & "quote" $secret'
    const html = await store.createProject({ name, starterId: 'static' })
    assert.match((await store.readFile(html.id, 'index.html')).content, /Studio &lt;\/script&gt; &amp; &quot;quote&quot; \$secret/)
    for (const starterId of ['react', 'vue', 'svelte']) {
      const project = await store.createProject({ name, starterId })
      const source = (await store.readFile(project.id, project.entryFile)).content
      assert.ok(source.includes('\\u003c/script>'))
      if (starterId !== 'react') assert.equal((source.match(/<\/script>/g) || []).length, 1)
    }
    const php = await store.createProject({ name, starterId: 'php' })
    const source = (await store.readFile(php.id, 'index.php')).content
    assert.ok(source.includes('\\$secret'))
    assert.match(source, /htmlspecialchars\(\$title/)
  })
})

test('opening an existing framework folder preserves its arbitrary source structure', async () => {
  await withStore(async (store, temporary) => {
    const folder = path.join(temporary, 'existing-astro')
    await fs.mkdir(path.join(folder, 'src', 'pages'), { recursive: true })
    const source = '---\nconst greeting = "Keep my Astro page"\n---\n<h1>{greeting}</h1>\n'
    await fs.writeFile(path.join(folder, 'src', 'pages', 'index.astro'), source)
    const project = await store.registerFolder(folder)
    assert.equal((await store.readFile(project.id, 'src/pages/index.astro')).content, source)
    assert.deepEqual((await store.listFiles(project.id)).items.filter(item => item.type === 'file').map(item => item.path), ['src/pages/index.astro'])
    assert.equal((await store.registerFolder(folder)).id, project.id)
  })
})
