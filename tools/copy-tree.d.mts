export function copyTree(source: string, destination: string, options?: {
  excludeDirectories?: string[]
  concurrency?: number
}): Promise<{ files: number; directories: number }>
