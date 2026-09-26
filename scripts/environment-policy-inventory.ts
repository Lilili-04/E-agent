import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { buildSourceInventory } from '../packages/experimental/environment-policy/src/inventory.ts'

function usage(): never {
  throw new Error('usage: node --experimental-strip-types scripts/environment-policy-inventory.ts --source-root <path> --output <path> [--pretty]')
}

function argument(name: string, args: readonly string[]): string | undefined {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

const args = process.argv.slice(2)
const sourceRoot = argument('--source-root', args)
const outputPath = argument('--output', args)
if (sourceRoot === undefined || outputPath === undefined) usage()
const inventory = await buildSourceInventory({ sourceRoot: resolve(sourceRoot) })
const output = JSON.stringify(inventory, null, args.includes('--pretty') ? 2 : 0)
await mkdir(dirname(resolve(outputPath)), { recursive: true })
await writeFile(resolve(outputPath), `${output}\n`, 'utf8')
console.log(`environment-policy: inventoried ${inventory.sourceCount} full.md files`)
console.log(`environment-policy: duplicate groups ${inventory.duplicateGroups.length}`)
console.log(`environment-policy: wrote ${resolve(outputPath)}`)
