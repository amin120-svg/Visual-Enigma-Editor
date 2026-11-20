import { readdir, mkdir, copyFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/** Bounded parallel copying for trusted build assets, with no link traversal. */
export async function copyTree(source, destination, { excludeDirectories = [], concurrency = 12 } = {}) {
  const excluded = new Set(excludeDirectories)
  const entries = await readdir(source, { recursive: true, withFileTypes: true })
  const files = []
  const directories = [destination]
  for (const entry of entries) {
    const absolute = join(entry.parentPath, entry.name)
    const local = relative(source, absolute)
    if (local.split(sep).some(part => excluded.has(part))) continue
    if (entry.isSymbolicLink()) throw new Error(`Build asset link is not allowed: ${local}`)
    const target = join(destination, local)
    if (entry.isDirectory()) directories.push(target)
    else if (entry.isFile()) files.push({ source: absolute, target })
    else throw new Error(`Unsupported build asset: ${local}`)
  }
  await Promise.all(directories.map(directory => mkdir(directory, { recursive: true })))
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), files.length) }, async () => {
    while (cursor < files.length) {
      const file = files[cursor++]
      await copyFile(file.source, file.target)
    }
  }))
  return { files: files.length, directories: directories.length }
}
