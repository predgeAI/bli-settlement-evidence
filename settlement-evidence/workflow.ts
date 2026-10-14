// Predge settlement evidence: a Chainlink CRE workflow.
//
// Input: a Polymarket market id (HTTP trigger {"market_id": "..."}, or cron over a watch list).
//   1. HTTP, every DON node: fetch Predge's signed Settlement Risk record
//      (api.predge.io/v1/settlement-risk/<id>) and the Predge key set; verify the signer is the
//      pinned key and active in the key set, the ed25519 signature, and sha256(canonical) ==
//      content_hash. Nodes reach consensus field by field (identical on every field).
//   2. EVM read, Polygon mainnet: the Conditional Tokens contract Polymarket pays out through
//      (getOutcomeSlotCount, payoutDenominator, payoutNumerators) for the record's condition id,
//      an independent check of what the record says about resolution.
//   3. Build the evidence pack (deterministic JSON + plain-English summary), sha256 = pack hash.
//   4. EVM write, testnet: a DON-signed report {marketId, conditionId, packHash, contentHash,
//      status, ...} delivered through the CRE forwarder to SettlementEvidenceRegistry.onReport.

import {
	bytesToHex,
	ConsensusAggregationByFields,
	cre,
	type CronPayload,
	decodeJson,
	encodeCallMsg,
	getNetwork,
	type HTTPPayload,
	type HTTPSendRequester,
	identical,
	json,
	LAST_FINALIZED_BLOCK_NUMBER,
	ok,
	prepareReportRequest,
	type Runtime,
	TxStatus,
} from '@chainlink/cre-sdk'
import { type Address, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, type Hex, parseAbi, parseAbiParameters, zeroAddress } from 'viem'
import { z } from 'zod'
import { buildPack, type CtfReading, PACK_STATUS, type PackStatus } from './evidence'
import { type Attestation, type KeySet, type SignedFacts, verifyAttestation } from './logic'

// ─── Config ────────────────────────────────────────────────────────────────────────────────────
export const configSchema = z.object({
	schedule: z.string(),
	apiBase: z.string().regex(/^https:\/\/[^\s/]+$/), // the WASM runtime has no URL global, so no .url()
	marketIds: z.array(z.string().regex(/^\d+$/)).min(1), // watched by the cron trigger
	predgePublicKey: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/), // pinned ed25519 key (kid 13fa3d18a369e6c7)
	checkKeySet: z.boolean(),
	read: z.object({
		chainSelectorName: z.string(), // "polygon-mainnet"
		ctfContract: z.string(), // Gnosis Conditional Tokens used by Polymarket
	}),
	write: z.object({
		chainSelectorName: z.string(), // a testnet, e.g. "ethereum-testnet-sepolia"
		receiverAddress: z.string(), // SettlementEvidenceRegistry; zero address = do not write
		gasLimit: z.string(),
	}),
})
export type Config = z.infer<typeof configSchema>

const CTF_ABI = parseAbi([
	'function getOutcomeSlotCount(bytes32 conditionId) view returns (uint256)',
	'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
	'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
])

// Report consumed by SettlementEvidenceRegistry._processReport.
export const REPORT_PARAMS = parseAbiParameters(
	'string marketId, bytes32 conditionId, bytes32 packHash, bytes32 recordContentHash, uint8 status, uint8 disputeCount, bool openDispute, uint64 recordIssuedAt',
)

export function encodeReport(r: EvidenceResult): Hex {
	return encodeAbiParameters(REPORT_PARAMS, [
		r.market_id,
		r.condition_id as Hex,
		r.pack_hash as Hex,
		r.record_content_hash as Hex,
		PACK_STATUS[r.status],
		Math.min(r.dispute_count, 255),
		r.open_dispute,
		BigInt(Math.floor(Date.parse(r.record_issued_at) / 1000)),
	])
}

// ─── Step 1: fetch + verify on every node ──────────────────────────────────────────────────────
// Only flat strings leave the node, so the identical-per-field consensus is well defined.
export type NodeObservation = {
	market_id: string
	canonical: string
	signature: string
	public_key: string
	kid: string
	content_hash: string
	question: string
	slug: string
	end_date: string
}

export const fetchAndVerify = (send: HTTPSendRequester, config: Config, marketId: string): NodeObservation => {
	// One node fetches, the others reuse the cached response, so every node verifies the same
	// signed bytes (Predge signs a fresh record, with a new issued_at, on every request).
	const resp = send
		.sendRequest({ url: `${config.apiBase}/v1/settlement-risk/${marketId}`, method: 'GET', cacheSettings: { store: true, maxAge: '60s' } })
		.result()
	if (!ok(resp)) throw new Error(`settlement-risk ${marketId}: HTTP ${resp.statusCode}`)
	const body = json(resp) as { attestation?: Attestation; market?: { question?: string; slug?: string; end_date?: string } }
	if (!body.attestation) throw new Error(`settlement-risk ${marketId}: no attestation in response`)

	let keySet: KeySet | undefined
	if (config.checkKeySet) {
		const k = send
			.sendRequest({ url: `${config.apiBase}/.well-known/predge-keys.json`, method: 'GET', cacheSettings: { store: true, maxAge: '300s' } })
			.result()
		if (!ok(k)) throw new Error(`predge-keys.json: HTTP ${k.statusCode}`)
		keySet = json(k) as KeySet
	}
	const v = verifyAttestation(body.attestation, config.predgePublicKey, marketId, keySet)
	return {
		market_id: marketId,
		canonical: body.attestation.canonical,
		signature: body.attestation.signature,
		public_key: body.attestation.public_key,
		kid: v.kid,
		content_hash: v.contentHash,
		question: body.market?.question ?? '',
		slug: body.market?.slug ?? '',
		end_date: body.market?.end_date ?? '',
	}
}

const observationConsensus = ConsensusAggregationByFields<NodeObservation>({
	market_id: identical,
	canonical: identical,
	signature: identical,
	public_key: identical,
	kid: identical,
	content_hash: identical,
	question: identical,
	slug: identical,
	end_date: identical,
})

// ─── Step 2: Polygon CTF read ──────────────────────────────────────────────────────────────────
const evmClientFor = (chainSelectorName: string) => {
	const network = getNetwork({ chainFamily: 'evm', chainSelectorName, isTestnet: /testnet|sepolia|amoy|fuji/.test(chainSelectorName) })
	if (!network) throw new Error(`unknown chain ${chainSelectorName}`)
	return new cre.capabilities.EVMClient(network.chainSelector.selector)
}

function ctfCall<F extends 'getOutcomeSlotCount' | 'payoutDenominator' | 'payoutNumerators'>(
	runtime: Runtime<Config>,
	client: InstanceType<typeof cre.capabilities.EVMClient>,
	functionName: F,
	args: readonly unknown[],
): bigint {
	const data = encodeFunctionData({ abi: CTF_ABI, functionName, args } as never)
	const res = client
		.callContract(runtime, {
			call: encodeCallMsg({ from: zeroAddress, to: runtime.config.read.ctfContract as Address, data }),
			blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
		})
		.result()
	return decodeFunctionResult({ abi: CTF_ABI, functionName, data: bytesToHex(res.data) } as never) as bigint
}

export function readCtf(runtime: Runtime<Config>, conditionId: Hex): CtfReading {
	const client = evmClientFor(runtime.config.read.chainSelectorName)
	const slots = Number(ctfCall(runtime, client, 'getOutcomeSlotCount', [conditionId]))
	const denominator = ctfCall(runtime, client, 'payoutDenominator', [conditionId])
	const numerators: string[] = []
	for (let i = 0; i < Math.min(slots, 8); i++) numerators.push(ctfCall(runtime, client, 'payoutNumerators', [conditionId, BigInt(i)]).toString())
	return { contract: runtime.config.read.ctfContract, outcome_slot_count: slots, payout_denominator: denominator.toString(), payout_numerators: numerators }
}

// ─── Steps 1-4 for one market ──────────────────────────────────────────────────────────────────
export type EvidenceResult = {
	market_id: string
	condition_id: string
	status: PackStatus
	open_dispute: boolean
	dispute_count: number
	pack_hash: string
	record_content_hash: string
	record_issued_at: string
	summary: string
	pack: unknown
}

export function buildEvidence(runtime: Runtime<Config>, marketId: string): EvidenceResult {
	const cfg = runtime.config
	const http = new cre.capabilities.HTTPClient()
	const obs = http.sendRequest(runtime, fetchAndVerify, observationConsensus)(cfg, marketId).result()
	// Re-verify at DON level: the consensus value is what goes into the pack.
	const v = verifyAttestation({ canonical: obs.canonical, signature: obs.signature, public_key: obs.public_key, kid: obs.kid, content_hash: obs.content_hash }, cfg.predgePublicKey, marketId)
	const f: SignedFacts = v.facts
	runtime.log(
		`[${marketId}] signed record verified on every node (pinned key ${obs.kid}, key set, ed25519, sha256), consensus reached: uma_state=${f.uma_state} open_dispute=${f.open_dispute} disputes=${f.dispute_count} outcome=${f.onchain_resolution?.outcome ?? '-'} content_hash=${v.contentHash}`,
	)

	const ctf = readCtf(runtime, f.condition_id as Hex)
	runtime.log(
		`[${marketId}] Polygon CTF ${cfg.read.ctfContract} condition ${f.condition_id}: slots=${ctf.outcome_slot_count} payoutDenominator=${ctf.payout_denominator} payoutNumerators=[${ctf.payout_numerators.join(',')}]`,
	)

	const { pack, packHash, status } = buildPack(f, { question: obs.question, slug: obs.slug, end_date: obs.end_date }, ctf, {
		kid: obs.kid,
		public_key: obs.public_key,
		signature: obs.signature,
		content_hash: v.contentHash,
		canonical: obs.canonical,
	})
	runtime.log(`[${marketId}] evidence pack status=${status} pack_hash=${packHash}`)
	runtime.log(`[${marketId}] summary: ${pack.summary}`)

	const result: EvidenceResult = {
		market_id: marketId,
		condition_id: f.condition_id,
		status,
		open_dispute: f.open_dispute,
		dispute_count: Number(f.dispute_count || '0'),
		pack_hash: packHash,
		record_content_hash: v.contentHash,
		record_issued_at: f.issued_at,
		summary: pack.summary,
		pack,
	}

	const receiver = cfg.write.receiverAddress
	if (!receiver || /^0x0{40}$/i.test(receiver)) {
		runtime.log(`[${marketId}] no receiver configured: report not written on chain`)
		return result
	}
	const report = runtime.report(prepareReportRequest(encodeReport(result))).result()
	const w = evmClientFor(cfg.write.chainSelectorName)
		.writeReport(runtime, { receiver, report, gasConfig: { gasLimit: cfg.write.gasLimit } })
		.result()
	if (w.txStatus !== TxStatus.SUCCESS) throw new Error(`writeReport failed: ${w.errorMessage || w.txStatus}`)
	const tx = bytesToHex(w.txHash || new Uint8Array(32))
	const sent = !/^0x0{64}$/.test(tx)
	runtime.log(
		`[${marketId}] DON-signed report (pack_hash, status=${PACK_STATUS[status]}) ${sent ? 'written' : 'prepared, dry run (no --broadcast, nothing sent)'} to ${receiver} on ${cfg.write.chainSelectorName}${sent ? `, tx ${tx}` : ''}`,
	)
	return result
}

// ─── Triggers ──────────────────────────────────────────────────────────────────────────────────
const brief = (r: EvidenceResult) => ({ market_id: r.market_id, status: r.status, pack_hash: r.pack_hash, record_content_hash: r.record_content_hash, summary: r.summary })

export const onCron = (runtime: Runtime<Config>, _payload: CronPayload): string =>
	JSON.stringify(runtime.config.marketIds.map((id) => brief(buildEvidence(runtime, id))))

const httpInput = z.object({ market_id: z.string().regex(/^\d+$/) })

export const onHttp = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
	if (!payload.input || payload.input.length === 0) throw new Error('HTTP trigger needs {"market_id": "..."}')
	const { market_id } = httpInput.parse(decodeJson(payload.input))
	const r = buildEvidence(runtime, market_id)
	return JSON.stringify({ ...brief(r), pack: r.pack }) // the full pack goes back to the caller
}

export function initWorkflow(config: Config) {
	const cron = new cre.capabilities.CronCapability()
	const http = new cre.capabilities.HTTPCapability()
	return [cre.handler(cron.trigger({ schedule: config.schedule }), onCron), cre.handler(http.trigger({}), onHttp)]
}
