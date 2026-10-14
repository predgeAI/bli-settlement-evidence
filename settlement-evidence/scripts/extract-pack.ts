// Pull the evidence pack out of a saved `cre workflow simulate` log (HTTP trigger result).
//   bun scripts/extract-pack.ts ../logs/simulate-http-2241873.log > ../logs/pack-2241873.json
import { readFileSync } from 'node:fs'
const log = readFileSync(process.argv[2], 'utf8')
const lines = log.split('\n')
const i = lines.findIndex((l) => l.includes('Workflow Simulation Result'))
if (i < 0) throw new Error('no simulation result in log')
const result = JSON.parse(JSON.parse(lines[i + 1])) // the CLI prints the result as a JSON string
console.log(JSON.stringify(result.pack, null, 2))
