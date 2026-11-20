'use strict'

// Maintainer build: run the existing compiler/bundler directly, without a shell.
const path = require('node:path')
const { spawn } = require('node:child_process')
const frontend = path.resolve(__dirname, '../../VEE-php/frontend')
async function run(arguments_) {
  const child = spawn(process.execPath, arguments_, { cwd: frontend, shell: false, windowsHide: true, stdio: 'inherit' })
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Build stage exited with ${code}`)))
  })
}
async function main() {
  console.log('Checking desktop TypeScript')
  await run(['node_modules/typescript/bin/tsc', '-b', '--pretty', 'false'])
  console.log('Building local renderer and Monaco assets')
  await run(['node_modules/vite/bin/vite.js', 'build', '--mode', 'desktop'])
  console.log('Desktop build complete')
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
