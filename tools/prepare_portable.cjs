'use strict'

// Maintainer-only packaging. End users open the EXE; no shell or build tools
// are installed into the application. The previous delivery is read-only.
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { createRequire } = require('node:module')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const execute = promisify(execFile)
const desktop = path.resolve(__dirname, '..')
const repository = path.dirname(desktop)
const releaseIdentifier = process.argv[2]
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(releaseIdentifier || '')) {
  throw new Error('An explicit release identifier is required')
}
const runtime = path.join(desktop, 'dist', 'VisualEnigmaEditor-0.1.0-win-x64')
const destination = path.join(desktop, 'dist', `VisualEnigmaEditor-${releaseIdentifier}-win-x64`)
const appRoot = path.join(destination, 'resources', 'app')
const expectedRuntimeHash = '1dc2d12e5c60341782e68c4b65a8e49cbd86217f81568f90575547cec13b5610'
const python = process.env.VEE_BUILD_PYTHON || 'C:/Users/Amin1/AppData/Local/Programs/Python/Python313/python.exe'
const runtimeFiles = [
  'VisualEnigmaEditor.exe', 'chrome_100_percent.pak', 'chrome_200_percent.pak',
  'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'icudtl.dat',
  'LICENSE', 'LICENSES.chromium.html', 'resources.pak', 'snapshot_blob.bin',
  'v8_context_snapshot.bin', 'version', 'vk_swiftshader.dll',
  'vk_swiftshader_icd.json', 'vulkan-1.dll', 'locales',
]
const appFiles = [
  'main.cjs', 'preload.cjs', 'workspace.cjs', 'agent-connection.cjs',
  'online-service.cjs', 'deploy/agent-client.mjs', 'deploy/plan.mjs',
]
async function digest(file) { return createHash('sha256').update(await fs.readFile(file)).digest('hex') }

async function main() {
  const { copyTree } = await import('./copy-tree.mjs')
  if (await digest(path.join(runtime, 'VisualEnigmaEditor.exe')) !== expectedRuntimeHash) {
    throw new Error('The previously verified Electron runtime executable has changed')
  }
  const frontendRequire = createRequire(path.join(repository, 'VEE-php', 'frontend', 'package.json'))
  const viteRequire = createRequire(frontendRequire.resolve('vite'))
  await viteRequire('esbuild').build({
    absWorkingDir: desktop, entryPoints: ['ai/index.ts'], bundle: true,
    platform: 'node', format: 'cjs', target: 'node24', outfile: 'build/ai-runtime.cjs',
  })
  for (const item of ['index.html', 'monaco/vs/loader.js', 'monaco/vs/editor/editor.main.js',
    'monaco/LICENSE', 'monaco/ThirdPartyNotices.txt', 'branding/vee-icon.ico', 'branding/py-snake-logo.png']) {
    await fs.access(path.join(desktop, 'renderer', item))
  }
  // mkdir without recursive intentionally refuses an existing delivery.
  await fs.mkdir(destination)
  await Promise.all(runtimeFiles.map(async file => {
    if (file === 'locales') await copyTree(path.join(runtime, file), path.join(destination, file))
    else await fs.copyFile(path.join(runtime, file), path.join(destination, file))
  }))
  await fs.mkdir(path.join(appRoot, 'build'), { recursive: true })
  for (const file of appFiles) {
    await fs.mkdir(path.dirname(path.join(appRoot, file)), { recursive: true })
    await fs.copyFile(path.join(desktop, file), path.join(appRoot, file))
  }
  await fs.copyFile(path.join(desktop, 'build/ai-runtime.cjs'), path.join(appRoot, 'build/ai-runtime.cjs'))
  await copyTree(path.join(desktop, 'renderer'), path.join(appRoot, 'renderer'), { excludeDirectories: ['archive'] })
  const sourcePackage = JSON.parse(await fs.readFile(path.join(desktop, 'package.json'), 'utf8'))
  // Keep the established Electron application identity/user-data directory.
  const packageData = {
    name: sourcePackage.name, private: true, version: sourcePackage.version,
    description: 'Visual Enigma Editor by Py Snake', main: 'main.cjs', releaseIdentifier,
  }
  await fs.writeFile(path.join(appRoot, 'package.json'), JSON.stringify(packageData, null, 2) + '\n', { flag: 'wx' })
  await fs.copyFile(path.join(repository, 'docs/WINDOWS-DESKTOP-QUICKSTART-FA.md'), path.join(destination, 'راهنمای-شروع-سریع-VEE.md'))
  await fs.copyFile(path.join(desktop, 'README.md'), path.join(destination, 'README-FIRST.md'))
  for (const guide of ['DESKTOP-WRITING.md', 'DESKTOP-PROJECT-STARTERS.md', 'DESKTOP-ONLINE.md']) {
    await fs.copyFile(path.join(repository, 'docs', guide), path.join(destination, guide))
  }
  const branding = await execute(python, [path.join(__dirname, 'brand_executable.py'),
    path.join(destination, 'VisualEnigmaEditor.exe'), path.join(appRoot, 'renderer/branding/vee-icon.ico'), releaseIdentifier],
  { shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })
  const provenance = {
    product: 'Visual Enigma Editor', releaseIdentifier, platform: 'win32-x64',
    electron: (await fs.readFile(path.join(runtime, 'version'), 'utf8')).trim(),
    sourceRuntimeSha256: expectedRuntimeHash,
    executableSha256: await digest(path.join(destination, 'VisualEnigmaEditor.exe')),
    companyLogoSha256: await digest(path.join(appRoot, 'renderer/branding/py-snake-logo.png')),
    pySnakeCodeSigned: false,
  }
  await fs.writeFile(path.join(destination, 'build-info.json'), JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx' })
  process.stdout.write(JSON.stringify({ destination, appRoot, branding: JSON.parse(branding.stdout), ...provenance }, null, 2) + '\n')
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
