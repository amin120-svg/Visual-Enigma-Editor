'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const path = require('node:path')

test('source language detection covers web ecosystems without restricting unknown files', async () => {
  const { languageFor, installedLanguageFor } = await import(pathToFileURL(path.resolve(__dirname, '../../VEE-php/frontend/src/desktop/editor-languages.ts')).href)
  const cases = {
    'src/App.tsx': 'typescript', 'src/main.mts': 'typescript', 'server.cjs': 'javascript',
    'page.blade.php': 'php', 'src/App.vue': 'html', 'src/App.svelte': 'html',
    'src/pages/index.astro': 'html', 'README.MDX': 'markdown', 'config.toml': 'ini',
    '.env.local': 'ini', 'api/schema.graphql': 'graphql', 'db/migration.sql': 'sql',
    'main.py': 'python', 'src/main.rs': 'rust', 'Main.java': 'java',
    'server.go': 'go', 'app.rb': 'ruby', 'Gemfile': 'ruby', 'main.dart': 'dart',
    'types.cs': 'csharp', 'layout.cshtml': 'razor', 'style.less': 'less',
    'page.html.twig': 'handlebars', 'compose.yaml': 'yaml', 'Dockerfile': 'dockerfile',
    'module.custom-language': 'plaintext', '.gitignore': 'plaintext', 'no-extension': 'plaintext',
    'C:\\project\\Main.CPP': 'cpp',
  }
  for (const [filename, language] of Object.entries(cases)) assert.equal(languageFor(filename), language, filename)
  const installed = [{ id: 'plaintext' }, { id: 'typescript' }, { id: 'html' }]
  assert.equal(installedLanguageFor('App.tsx', installed), 'typescript')
  assert.equal(installedLanguageFor('main.rs', installed), 'plaintext')
  assert.equal(installedLanguageFor('custom.source', installed, 'html'), 'html')
  assert.equal(installedLanguageFor('custom.source', installed, 'unavailable-language'), 'plaintext')
})
