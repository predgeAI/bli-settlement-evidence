// Checks, without deploying or spending anything, that SettlementEvidenceRegistry accepts the exact
// report this workflow produces for a pack, and only from the forwarder. Uses eth_simulateV1 on
// Sepolia with a state override (the compiled registry code placed at a scratch address).
//   bun scripts/check-registry.ts ../logs/pack-2241873.json
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { decodeEventLog, encodeFunctionData, type Hex, pad } from 'viem'
import { canon, sha256Hex } from '../logic'
import { encodeReport } from '../workflow'

const RPC = process.env.SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com'
const FORWARDER = '0x15fC6ae953E024d975e77382eEeC56A9101f9F88' // Sepolia MockKeystoneForwarder
const SCRATCH = '0x00000000000000000000000000000000c0ffee01'
const build = JSON.parse(readFileSync(path.join(import.meta.dir, '../../contracts/build/SettlementEvidenceRegistry.json'), 'utf8'))
const pack = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const report = encodeReport({
	market_id: pack.market.market_id,
	condition_id: pack.market.condition_id,
	status: pack.status,
	open_dispute: pack.outcome.open_dispute,
	dispute_count: pack.resolution_process.dispute_count,
	pack_hash: sha256Hex(canon(pack)),
	record_content_hash: pack.provenance.content_hash,
	record_issued_at: pack.provenance.record_issued_at,
	summary: '',
	pack,
})
const data = encodeFunctionData({ abi: build.abi, functionName: 'onReport', args: ['0x', report] })
const call = (from: string) => ({ from, to: SCRATCH, data })
const body = {
	jsonrpc: '2.0',
	id: 1,
	method: 'eth_simulateV1',
	params: [
		{
			blockStateCalls: [
				{
					stateOverrides: { [SCRATCH]: { code: build.deployedBytecode, state: { [pad('0x1')]: pad(FORWARDER.toLowerCase() as Hex) } } }, // slot 1 = forwarder
					calls: [call(FORWARDER), call('0x000000000000000000000000000000000000dEaD')],
				},
			],
			validation: false,
		},
		'latest',
	],
}
const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
if (res.error) throw new Error(JSON.stringify(res.error))
const [fromForwarder, fromOther] = res.result[0].calls
console.log(`onReport from MockKeystoneForwarder: status ${fromForwarder.status}, gasUsed ${parseInt(fromForwarder.gasUsed, 16)}`)
for (const l of fromForwarder.logs) {
	const ev = decodeEventLog({ abi: build.abi, data: l.data, topics: l.topics })
	console.log(`  ${ev.eventName}`, JSON.stringify(ev.args, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
}
console.log(`onReport from any other sender: status ${fromOther.status}${fromOther.error ? ` (${fromOther.error.message ?? 'reverted'})` : ''}`)
