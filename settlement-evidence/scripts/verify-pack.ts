// Independent check of an evidence pack, for the other side's expert or a court-appointed one.
//   bun scripts/verify-pack.ts ../logs/pack-2241873.json [--rpc https://polygon-bor-rpc.publicnode.com]
// 1. re-verifies the embedded signed Predge record (pinned key, ed25519, sha256 == content_hash);
// 2. rebuilds the pack from that record + the CTF reading in the pack and checks it is identical,
//    so no field of the pack was edited after the workflow produced it;
// 3. prints the pack hash to look up on chain (SettlementEvidenceRegistry.isAnchored(packHash));
// 4. with --rpc, re-reads payoutDenominator on Polygon now (it may have changed since, e.g. a
//    dispute that was open is now settled; that is reported, not treated as a failure).
import { readFileSync } from 'node:fs'
import { decodeFunctionResult, encodeFunctionData, type Hex, parseAbi } from 'viem'
import { buildPack } from '../evidence'
import { canon, sha256Hex, verifyAttestation } from '../logic'

const PINNED = '13fa3d18a369e6c71bf941563ba47822b30182273d5106a0e8fb61c5016352d9'
const file = process.argv[2]
const rpcIdx = process.argv.indexOf('--rpc')
const pack = JSON.parse(readFileSync(file, 'utf8'))
const p = pack.provenance
const v = verifyAttestation({ canonical: p.signed_record_canonical, signature: p.signature, public_key: p.public_key, content_hash: p.content_hash }, PINNED, pack.market.market_id)
console.log(`1. signed record: OK (key ${v.kid}, ed25519 verified, sha256 ${v.contentHash})`)

const { packHash } = buildPack(
	v.facts,
	{ question: pack.market_metadata_unsigned.question, slug: pack.market_metadata_unsigned.slug, end_date: pack.market_metadata_unsigned.end_date },
	{ contract: pack.polygon_ctf_check.contract, outcome_slot_count: pack.polygon_ctf_check.outcome_slot_count, payout_denominator: pack.polygon_ctf_check.payout_denominator, payout_numerators: pack.polygon_ctf_check.payout_numerators },
	{ kid: p.signer_kid, public_key: p.public_key, signature: p.signature, content_hash: v.contentHash, canonical: p.signed_record_canonical },
)
const given = sha256Hex(canon(pack))
if (given !== packHash) {
	console.log(`2. FAIL: pack hash ${given} but the pack rebuilt from the signed record hashes to ${packHash}`)
	process.exit(1)
}
console.log(`2. pack rebuilt from the signed record: identical`)
console.log(`3. pack_hash ${packHash}  status ${pack.status}`)

if (rpcIdx > 0) {
	const abi = parseAbi(['function payoutDenominator(bytes32) view returns (uint256)'])
	const data = encodeFunctionData({ abi, functionName: 'payoutDenominator', args: [pack.market.condition_id as Hex] })
	const r = await fetch(process.argv[rpcIdx + 1], {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: pack.polygon_ctf_check.contract, data }, 'finalized'] }),
	}).then((x) => x.json())
	const den = decodeFunctionResult({ abi, functionName: 'payoutDenominator', data: r.result }).toString()
	console.log(`4. Polygon now: payoutDenominator=${den} (pack recorded ${pack.polygon_ctf_check.payout_denominator})${den === pack.polygon_ctf_check.payout_denominator ? '' : ' -> state changed since the pack was made'}`)
}
