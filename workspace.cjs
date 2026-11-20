'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_FILES = 5000
const HIDDEN_DIRECTORIES = new Set(['.git', 'node_modules', '.venv', 'vendor'])

function cleanName(value) {
  if (typeof value !== 'string') throw new Error('Project name is required')
  const name = value.trim()
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
    throw new Error('Project name must contain 1–80 printable characters')
  }
  return name
}

function cleanRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Invalid project file path')
  }
  const parts = value.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /[<>:"|?*]/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Invalid project file path')
  }
  return parts
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

// These are source templates, not runtime installers. Creating or opening a
// project never installs dependencies or runs project code.
const STARTERS = Object.freeze([
  { id: 'blank', name: 'Blank project', category: 'Start clean', description: 'An empty workspace for any language or framework.', requirement: 'Bring your own source and runtime.', entryFile: 'README.md' },
  { id: 'static', name: 'HTML / CSS / JavaScript', category: 'Website', description: 'A responsive page with separate styles and browser JavaScript.', requirement: 'HTML preview is available; preview scripts remain disabled.', entryFile: 'index.html' },
  { id: 'portfolio', name: 'Portfolio', category: 'Website', description: 'An introduction, selected work, and contact links.', requirement: 'Plain HTML, CSS, and JavaScript. No dependencies.', entryFile: 'index.html' },
  { id: 'business', name: 'Business website', category: 'Website', description: 'A home page, services, and contact information.', requirement: 'Plain HTML, CSS, and JavaScript. No dependencies.', entryFile: 'index.html' },
  { id: 'docs', name: 'Documentation', category: 'Website', description: 'A readable documentation page with section navigation.', requirement: 'Plain HTML, CSS, and JavaScript. No dependencies.', entryFile: 'index.html' },
  { id: 'react', name: 'React + TypeScript', category: 'Framework', description: 'Vite configuration, a React component, and typed entry point.', requirement: 'Requires Node.js 20.19+ or 22.12+ and installed dependencies on a configured runtime.', entryFile: 'src/App.tsx' },
  { id: 'vue', name: 'Vue + TypeScript', category: 'Framework', description: 'A Vue single-file component and Vite configuration.', requirement: 'Requires Node.js 20.19+ or 22.12+ and installed dependencies on a configured runtime.', entryFile: 'src/App.vue' },
  { id: 'svelte', name: 'Svelte + TypeScript', category: 'Framework', description: 'A Svelte component, typed entry point, and Vite configuration.', requirement: 'Requires Node.js 20.19+ or 22.12+ and installed dependencies on a configured runtime.', entryFile: 'src/App.svelte' },
  { id: 'php', name: 'PHP website', category: 'Backend', description: 'A PHP page with a static stylesheet and deployment notes.', requirement: 'Requires a PHP-enabled server. PHP is not executed by the editor.', entryFile: 'index.php' },
  { id: 'flask', name: 'Python / Flask', category: 'Backend', description: 'A Flask application, HTML template, and dependency manifest.', requirement: 'Requires Python and Flask on a configured runtime. The editor does not start a Python server.', entryFile: 'app.py' },
  { id: 'node', name: 'Node.js / Express', category: 'Backend', description: 'An Express application serving a public website folder.', requirement: 'Requires Node.js and dependencies on a configured runtime. The editor does not start a Node server.', entryFile: 'server.js' },
])

function starterFor(value) {
  const starter = STARTERS.find(item => item.id === value)
  if (!starter) throw new Error('Choose a supported project starter')
  return starter
}

function starterFiles(starter, name) {
  const title = escapeHtml(name)
  const text = JSON.stringify(name).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  const packageName = 'vee-website'
  const page = body => `<!doctype html>\n<html lang="en" dir="ltr">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <meta name="description" content="${title} — built with Visual Enigma Editor.">\n  <title>${title}</title>\n  <link rel="stylesheet" href="styles.css">\n</head>\n<body>\n${body}\n  <script src="app.js"></script>\n</body>\n</html>\n`
  const css = ':root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.6; color: light-dark(#202733, #edf1f5); background: light-dark(#f7f8fa, #17202b); }\nbody { margin: 0; }\nmain, nav, footer { max-width: 68rem; margin: auto; padding: 2rem; }\nnav { display: flex; flex-wrap: wrap; gap: 1.5rem; }\na { color: light-dark(#145bb8, #8bbaff); }\nh1 { font-size: clamp(2rem, 5vw, 4rem); line-height: 1.1; }\nsection { margin-block: 3rem; }\n.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 1.5rem; }\narticle { padding: 1.5rem; border: 1px solid light-dark(#dbe0e7, #3b4654); border-radius: 0.75rem; }\nbutton { font: inherit; cursor: pointer; padding: 0.65rem 1rem; border-radius: 0.5rem; }\n'
  const readme = `# ${name}\n\nCreated with Visual Enigma Editor using the ${starter.name} starter.\n\n${starter.requirement}\n\nAll source files are editable. Project creation does not execute code or install dependencies. Framework components can be edited as source; dedicated language-server diagnostics and framework runtime previews are not included in this desktop editor.\n`
  if (starter.id === 'blank') return { 'README.md': readme }
  const staticBodies = {
    static: `  <nav aria-label="Main navigation"><a href="#home">Home</a><a href="#about">About</a></nav>\n  <main id="home"><h1>${title}</h1><p>Make room for your next idea.</p><section id="about"><h2>About this website</h2><p>Replace this text with your own story.</p></section></main>`,
    portfolio: `  <nav aria-label="Main navigation"><a href="#about">About</a><a href="#work">Work</a><a href="#contact">Contact</a></nav>\n  <main><section id="about"><p>Designer &amp; developer</p><h1>${title}</h1><p>I build useful experiences for the web.</p></section><section id="work"><h2>Selected work</h2><div class="cards"><article><h3>Project One</h3><p>Introduce your work, process, and results.</p></article><article><h3>Project Two</h3><p>Add another project that you are proud of.</p></article></div></section><section id="contact"><h2>Let’s work together</h2><p>Add your preferred contact details here.</p></section></main>`,
    business: `  <nav aria-label="Main navigation"><a href="#home">Home</a><a href="#services">Services</a><a href="#contact">Contact</a></nav>\n  <main><section id="home"><h1>${title}</h1><p>Thoughtful services, built around your needs.</p><a href="#services">Explore our services</a></section><section id="services"><h2>What we do</h2><div class="cards"><article><h3>Strategy</h3><p>Turn your priorities into a practical plan.</p></article><article><h3>Design</h3><p>Create a clear and approachable experience.</p></article><article><h3>Development</h3><p>Build reliable tools that work for your business.</p></article></div></section><section id="contact"><h2>Contact us</h2><p>Add your business contact details here.</p></section></main>`,
    docs: `  <nav aria-label="Documentation sections"><a href="#overview">Overview</a><a href="#getting-started">Getting started</a><a href="#reference">Reference</a></nav>\n  <main><h1>${title}</h1><section id="overview"><h2>Overview</h2><p>Explain what your project does and who it is for.</p></section><section id="getting-started"><h2>Getting started</h2><ol><li>Describe the first step.</li><li>Explain the next action.</li><li>Show the expected result.</li></ol></section><section id="reference"><h2>Reference</h2><p>Document configuration, concepts, and examples here.</p><pre><code>{ "example": true }</code></pre></section></main>`,
  }
  if (staticBodies[starter.id]) return { 'index.html': page(staticBodies[starter.id]), 'styles.css': css, 'app.js': '// Add browser interactions here.\n', 'README.md': readme }
  if (starter.id === 'php') return {
    'index.php': `<?php\ndeclare(strict_types=1);\n$title = ${JSON.stringify(name).replace(/\$/g, '\\$')};\n?>\n<!doctype html>\n<html lang="en" dir="ltr">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title><?= htmlspecialchars($title, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') ?></title><link rel="stylesheet" href="styles.css"></head>\n<body><main><h1><?= htmlspecialchars($title, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') ?></h1><p>Your PHP website starts here.</p></main></body>\n</html>\n`,
    'styles.css': css, 'README.md': readme,
  }
  if (starter.id === 'flask') return {
    'app.py': 'from flask import Flask, render_template\n\napp = Flask(__name__)\n\n\n@app.get("/")\ndef home():\n    return render_template("index.html")\n',
    'requirements.txt': 'Flask>=3.1,<4\n',
    'templates/index.html': page(`  <main><h1>${title}</h1><p>Your Flask website starts here.</p></main>`).replace('href="styles.css"', 'href="{{ url_for(\'static\', filename=\'styles.css\') }}"').replace('  <script src="app.js"></script>\n', ''),
    'static/styles.css': css, 'README.md': readme, '.gitignore': '.venv/\n__pycache__/\n.env\n',
  }
  if (starter.id === 'node') return {
    'server.js': "import express from 'express'\nimport path from 'node:path'\nimport { fileURLToPath } from 'node:url'\n\nconst app = express()\nconst directory = path.dirname(fileURLToPath(import.meta.url))\napp.disable('x-powered-by')\napp.use(express.static(path.join(directory, 'public')))\nconst port = Number(process.env.PORT || 3000)\napp.listen(port, '127.0.0.1')\n",
    'package.json': JSON.stringify({ name: packageName, private: true, type: 'module', scripts: { start: 'node server.js' }, dependencies: { express: '^5.1.0' } }, null, 2) + '\n',
    'public/index.html': page(`  <main><h1>${title}</h1><p>Your Node.js website starts here.</p></main>`),
    'public/styles.css': css, 'public/app.js': '// Add browser interactions here.\n',
    'README.md': readme, '.gitignore': 'node_modules/\n.env\n',
  }
  const configs = {
    react: { plugin: '@vitejs/plugin-react', version: '^4.7.0', dependencies: { react: '^19.1.1', 'react-dom': '^19.1.1' }, dev: { '@types/react': '^19.1.10', '@types/react-dom': '^19.1.7' }, entry: 'main.tsx', pluginImport: "import framework from '@vitejs/plugin-react'" },
    vue: { plugin: '@vitejs/plugin-vue', version: '^6.0.0', dependencies: { vue: '^3.5.0' }, dev: {}, entry: 'main.ts', pluginImport: "import framework from '@vitejs/plugin-vue'" },
    svelte: { plugin: '@sveltejs/vite-plugin-svelte', version: '^6.0.0', dependencies: { svelte: '^5.0.0' }, dev: {}, entry: 'main.ts', pluginImport: "import { svelte as framework } from '@sveltejs/vite-plugin-svelte'" },
  }
  const config = configs[starter.id]
  const result = {
    'README.md': readme,
    '.gitignore': 'node_modules/\ndist/\n.env\n',
    'package.json': JSON.stringify({ name: packageName, private: true, type: 'module', engines: { node: '^20.19.0 || >=22.12.0' }, scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' }, dependencies: config.dependencies, devDependencies: { vite: '^7.1.5', typescript: '^5.9.2', [config.plugin]: config.version, ...config.dev } }, null, 2) + '\n',
    'vite.config.ts': `import { defineConfig } from 'vite'\n${config.pluginImport}\n\nexport default defineConfig({ plugins: [framework()] })\n`,
    'index.html': `<!doctype html>\n<html lang="en" dir="ltr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><div id="app"></div><script type="module" src="/src/${config.entry}"></script></body></html>\n`,
    'src/styles.css': css,
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, jsx: 'react-jsx', skipLibCheck: true, allowImportingTsExtensions: true, noEmit: true, lib: ['ES2022', 'DOM'] }, include: ['src', 'vite.config.ts'] }, null, 2) + '\n',
  }
  if (starter.id === 'react') Object.assign(result, {
    'src/main.tsx': "import { StrictMode } from 'react'\nimport { createRoot } from 'react-dom/client'\nimport App from './App'\nimport './styles.css'\n\ncreateRoot(document.getElementById('app')!).render(<StrictMode><App /></StrictMode>)\n",
    'src/App.tsx': `import { useState } from 'react'\n\nexport default function App() {\n  const [count, setCount] = useState(0)\n  return <main><h1>{${text}}</h1><p>Your React website starts here.</p><button onClick={() => setCount(count + 1)}>Clicked {count} times</button></main>\n}\n`,
  })
  if (starter.id === 'vue') Object.assign(result, {
    'src/main.ts': "import { createApp } from 'vue'\nimport App from './App.vue'\nimport './styles.css'\n\ncreateApp(App).mount('#app')\n",
    'src/App.vue': `<script setup lang="ts">\nimport { ref } from 'vue'\nconst title = ${text}\nconst count = ref(0)\n</script>\n\n<template>\n  <main><h1>{{ title }}</h1><p>Your Vue website starts here.</p><button @click="count++">Clicked {{ count }} times</button></main>\n</template>\n`,
    'src/env.d.ts': '/// <reference types="vite/client" />\n\ndeclare module "*.vue" {\n  import type { DefineComponent } from "vue"\n  const component: DefineComponent\n  export default component\n}\n',
  })
  if (starter.id === 'svelte') Object.assign(result, {
    'src/main.ts': "import { mount } from 'svelte'\nimport App from './App.svelte'\nimport './styles.css'\n\nmount(App, { target: document.getElementById('app')! })\n",
    'src/App.svelte': `<script lang="ts">\n  const title = ${text}\n  let count = $state(0)\n</script>\n\n<main><h1>{title}</h1><p>Your Svelte website starts here.</p><button onclick={() => count++}>Clicked {count} times</button></main>\n`,
    'src/env.d.ts': '/// <reference types="vite/client" />\n',
  })
  return result
}

class WorkspaceStore {
  constructor(userDataDirectory) {
    this.directory = path.resolve(userDataDirectory)
    this.registryPath = path.join(this.directory, 'projects.json')
    this.projectDirectory = path.join(this.directory, 'projects')
    this.registryQueue = Promise.resolve()
    this.fileWriteQueues = new Map()
  }

  async updateRegistry(change) {
    const operation = this.registryQueue.then(async () => {
      const current = await this.readRegistry()
      const { next, result } = await change(current)
      if (next) await this.writeRegistry(next)
      return result
    })
    this.registryQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  async readRegistry() {
    let raw
    try {
      raw = await fs.readFile(this.registryPath, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const projects = JSON.parse(raw)
    if (!Array.isArray(projects) || projects.some(item =>
      !item || typeof item.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.id) ||
      typeof item.name !== 'string' || typeof item.root !== 'string' || !path.isAbsolute(item.root)
    )) throw new Error('Local project registry is invalid')
    return projects
  }

  async writeRegistry(projects) {
    await fs.mkdir(this.directory, { recursive: true })
    const temporary = `${this.registryPath}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(projects, null, 2), { flag: 'wx', mode: 0o600 })
      await fs.rename(temporary, this.registryPath)
    } catch (error) {
      await fs.unlink(temporary).catch(() => {})
      throw error
    }
  }

  async listProjects() {
    return (await this.readRegistry()).map(({ id, name, root, createdAt, starterId, entryFile }) => ({ id, name, root, createdAt, ...(starterId ? { starterId, entryFile } : {}) }))
  }

  listStarters() {
    return STARTERS.map(starter => ({ ...starter }))
  }

  async createProject(input) {
    const name = cleanName(input?.name)
    const starter = starterFor(input?.starterId ?? 'static')
    const files = starterFiles(starter, name)
    const id = randomUUID()
    await fs.mkdir(this.projectDirectory, { recursive: true })
    const root = path.join(this.projectDirectory, id)
    await fs.mkdir(root, { recursive: false })
    try {
      for (const [relative, content] of Object.entries(files)) {
        const target = path.join(root, ...cleanRelativePath(relative))
        if (!isInside(root, target)) throw new Error('Invalid starter file path')
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, content, { flag: 'wx', mode: 0o600 })
      }
      const project = { id, name, root, createdAt: new Date().toISOString(), starterId: starter.id, entryFile: starter.entryFile }
      return await this.updateRegistry(current => ({ next: [...current, project], result: project }))
    } catch (error) {
      // Only this newly allocated, unregistered UUID workspace is removed.
      // Existing projects and folders selected by the user are never touched.
      if (isInside(this.projectDirectory, root) && path.basename(root) === id) {
        await fs.rm(root, { recursive: true, force: true }).catch(() => {})
      }
      throw error
    }
  }

  async registerFolder(folder) {
    const root = await fs.realpath(folder)
    if (!(await fs.stat(root)).isDirectory()) throw new Error('Choose a project folder')
    return this.updateRegistry(projects => {
      const existing = projects.find(project => path.relative(project.root, root) === '')
      if (existing) return { next: null, result: existing }
      const project = { id: randomUUID(), name: cleanName(path.basename(root)), root, createdAt: new Date().toISOString() }
      return { next: [...projects, project], result: project }
    })
  }

  async project(projectId) {
    if (typeof projectId !== 'string') throw new Error('Invalid project')
    const project = (await this.readRegistry()).find(item => item.id === projectId)
    if (!project) throw new Error('Project not found')
    const actualRoot = await fs.realpath(project.root)
    if (path.relative(project.root, actualRoot) !== '' || !(await fs.stat(actualRoot)).isDirectory()) {
      throw new Error('Project folder changed or is unavailable')
    }
    return project
  }

  async filePath(project, relativePath, allowMissing = false) {
    const parts = cleanRelativePath(relativePath)
    const full = path.resolve(project.root, ...parts)
    if (!isInside(project.root, full)) throw new Error('File is outside this project')
    let current = project.root
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index])
      let stat
      try {
        stat = await fs.lstat(current)
      } catch (error) {
        if (allowMissing && error.code === 'ENOENT' && index === parts.length - 1) break
        throw error
      }
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not editable in VEE')
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('Parent must be a directory')
      if (index === parts.length - 1 && !stat.isFile()) throw new Error('Choose a regular file')
    }
    const realParent = await fs.realpath(path.dirname(full))
    if (path.relative(path.dirname(full), realParent) !== '' ||
        (path.relative(project.root, realParent) !== '' && !isInside(project.root, realParent))) {
      throw new Error('File parent is outside this project')
    }
    if (!allowMissing) {
      const realFile = await fs.realpath(full)
      if (path.relative(full, realFile) !== '' || !isInside(project.root, realFile)) {
        throw new Error('File is outside this project')
      }
    }
    return full
  }

  async listFiles(projectId) {
    const project = await this.project(projectId)
    const items = []
    const visit = async (directory, prefix, depth) => {
      if (depth > 20 || items.length >= MAX_FILES) return
      const entries = await fs.readdir(directory, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (items.length >= MAX_FILES) return
        if (entry.isSymbolicLink()) continue
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (HIDDEN_DIRECTORIES.has(entry.name)) continue
          items.push({ path: relative, type: 'directory' })
          await visit(path.join(directory, entry.name), relative, depth + 1)
        } else if (entry.isFile()) {
          items.push({ path: relative, type: 'file' })
        }
      }
    }
    await visit(project.root, '', 0)
    return { items, truncated: items.length >= MAX_FILES }
  }

  async readFile(projectId, relativePath) {
    const project = await this.project(projectId)
    const full = await this.filePath(project, relativePath)
    const stat = await fs.stat(full)
    if (stat.size > MAX_TEXT_BYTES) throw new Error('Text file is larger than 2 MB')
    const bytes = await fs.readFile(full)
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (content.includes('\0')) throw new Error('Binary files are not editable in this text editor')
    return { path: relativePath, content }
  }

  async createFile(projectId, relativePath) {
    const project = await this.project(projectId)
    const full = await this.filePath(project, relativePath, true)
    await fs.writeFile(full, '', { flag: 'wx', mode: 0o600 })
    return { path: relativePath }
  }

  async createDirectory(projectId, relativePath) {
    const project = await this.project(projectId)
    const parts = cleanRelativePath(relativePath)
    const full = path.resolve(project.root, ...parts)
    if (!isInside(project.root, full)) throw new Error('Folder is outside this project')
    let current = project.root
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index])
      let stat
      try { stat = await fs.lstat(current) }
      catch (error) {
        if (error.code !== 'ENOENT' || index !== parts.length - 1) throw error
        const parent = await fs.realpath(path.dirname(current))
        if (path.relative(path.dirname(current), parent) !== '' ||
            (path.relative(project.root, parent) !== '' && !isInside(project.root, parent))) {
          throw new Error('Folder parent is outside this project')
        }
        await fs.mkdir(current)
        stat = await fs.lstat(current)
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Choose a regular project folder')
      const realDirectory = await fs.realpath(current)
      if (path.relative(current, realDirectory) !== '' || !isInside(project.root, realDirectory)) {
        throw new Error('Folder is outside this project')
      }
    }
    return { path: relativePath }
  }

  async writeFile(projectId, relativePath, content, expectedContent) {
    if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) {
      throw new Error('Text file must be no larger than 2 MB')
    }
    if (expectedContent !== undefined && typeof expectedContent !== 'string') throw new Error('Invalid saved file snapshot')
    const key = `${projectId}/${relativePath}`
    const previous = this.fileWriteQueues.get(key) || Promise.resolve()
    const operation = previous.then(() => this.writeFileNow(projectId, relativePath, content, expectedContent))
    const completion = operation.then(() => undefined, () => undefined)
    this.fileWriteQueues.set(key, completion)
    void completion.then(() => {
      if (this.fileWriteQueues.get(key) === completion) this.fileWriteQueues.delete(key)
    })
    return operation
  }

  async writeFileNow(projectId, relativePath, content, expectedContent) {
    const project = await this.project(projectId)
    const full = await this.filePath(project, relativePath, true)
    const temporary = path.join(path.dirname(full), `.vee-${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
      await this.filePath(project, relativePath, true)
      if (expectedContent !== undefined) {
        const current = await fs.readFile(full, 'utf8').catch(() => null)
        if (current !== expectedContent) throw new Error('The file changed on disk. Reopen it before saving your changes.')
      }
      await fs.rename(temporary, full)
    } catch (error) {
      await fs.unlink(temporary).catch(() => {})
      throw error
    }
    return { path: relativePath, bytes: Buffer.byteLength(content, 'utf8') }
  }
}

module.exports = { WorkspaceStore }
