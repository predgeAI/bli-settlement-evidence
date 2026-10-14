import { describe, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getNetwork, TxStatus } from '@chainlink/cre-sdk'
import { EvmMock, HttpActionsMock, newTestRuntime, test } from '@chainlink/cre-sdk/test'
import { bytesToHex, decodeAbiParameters, decodeFunctionData, encodeFunctionResult, hexToBytes, parseAbi } from 'viem'
import { buildEvidence, type Config, initWorkflow, onHttp, REPORT_PARAMS } from './workflow'

const here = (p: string) => path.join(import.meta.dir, p)
const staging = JSON.parse(readFileSync(here('config.staging.json'), 'utf8')) as Config
const config = { ...staging, write: { ...staging.write, receiverAddress: '0x0000000000000000000000000000000000000000' } } as Config
const fixture = (m: string) => readFileSync(here(`fixtures/settlement-risk-${m}.json`))
const POLYGON = getNetwork({ chainFamily: 'evm', chainSelectorName: 'polygon-mainnet', isTestnet: false })!.chainSelector.selector
const SEPOLIA = getNetwork({ chainFamily: 'evm', chainSelectorName: 'ethereum-testnet-sepolia', isTestnet: true })!.chainSelector.selector
const CTF_ABI = parseAbi([
	'function getOutcomeSlotCount(bytes32) view returns (uint256)',
	'function payoutDenominator(bytes32) view returns (uint256)',
	'function payoutNumerators(bytes32, uint256) view returns (uint256)',
])
// Polygon state as read on 14 Oct 2026: 5219930 unresolved, 2241873 resolved to index 1 ("No").
const CHAIN: Record<string, { den: bigint; num: bigint[] }> = {
	'0x50d446794ad4e7b16e27e248ed841c76ca7edbb084907f61cd5a9d1f83cf96a8': { den: 0n, num: [0n, 0n] },
	'0x4ba348328e4d4ddee9e6734c9a369b2e8138611651f9f6dc8f59dea51df6c734': { den: 1n, num: [0n, 1n] },
}

function mocks() {
	const http = HttpActionsMock.testInstance()
	const urls: string[] = []
	http.sendRequest = (req) => {
		urls.push(req.url)
		if (req.url.endsWith('/.well-known/predge-keys.json')) return { statusCode: 200, body: readFileSync(here('fixtures/predge-keys.json')), headers: {} }
		return { statusCode: 200, body: fixture(req.url.split('/').pop()!), headers: {} }
	}
	const reads: string[] = []
	const polygon = EvmMock.testInstance(POLYGON)
	polygon.callContract = (req) => {
		const { functionName, args } = decodeFunctionData({ abi: CTF_ABI, data: bytesToHex(req.call!.data) })
		reads.push(functionName)
		const c = CHAIN[args[0] as string]
		const v = functionName === 'getOutcomeSlotCount' ? 2n : functionName === 'payoutDenominator' ? c.den : c.num[Number(args[1])]
		return { data: hexToBytes(encodeFunctionResult({ abi: CTF_ABI, functionName, result: v } as never)) }
	}
	const writes: Uint8Array[] = []
	const sepolia = EvmMock.testInstance(SEPOLIA)
	sepolia.writeReport = (req) => {
		writes.push(req.report!.rawReport)
		return { txStatus: TxStatus.SUCCESS, txHash: new Uint8Array(32).fill(0xab) }
	}
	return { urls, reads, writes }
}

const runtimeWith = (cfg: Config) => {
	const rt = newTestRuntime<Config>()
	;(rt as unknown as { config: Config }).config = cfg
	return rt
}

describe('buildEvidence', () => {
	test('open dispute: fetches record + key set, reads the CTF on Polygon, no write without a receiver', () => {
		const { urls, reads, writes } = mocks()
		const r = buildEvidence(runtimeWith(config), '5219930')
		expect(urls).toEqual(['https://api.predge.io/v1/settlement-risk/5219930', 'https://api.predge.io/.well-known/predge-keys.json'])
		expect(reads).toEqual(['getOutcomeSlotCount', 'payoutDenominator', 'payoutNumerators', 'payoutNumerators'])
		expect(r).toMatchObject({ market_id: '5219930', status: 'open-dispute', open_dispute: true, dispute_count: 2 })
		expect(writes).toHaveLength(0)
	})

	test('with a receiver: writes one DON report that decodes to the pack hash and status', () => {
		const { writes } = mocks()
		const cfg = { ...config, write: { ...config.write, receiverAddress: '0x00000000000000000000000000000000000000aa' } }
		const r = buildEvidence(runtimeWith(cfg), '2241873')
		expect(r.status).toBe('settled-differently')
		expect(writes).toHaveLength(1)
		const payload = bytesToHex(writes[0].slice(109)) // 109-byte metadata header + abi payload
		const [marketId, conditionId, packHash, contentHash, status, disputes, open, issuedAt] = decodeAbiParameters(REPORT_PARAMS, payload)
		expect({ marketId, conditionId, packHash, contentHash, status, disputes, open }).toEqual({
			marketId: '2241873',
			conditionId: '0x4ba348328e4d4ddee9e6734c9a369b2e8138611651f9f6dc8f59dea51df6c734',
			packHash: r.pack_hash as `0x${string}`,
			contentHash: r.record_content_hash as `0x${string}`,
			status: 4,
			disputes: 2,
			open: false,
		})
		expect(Number(issuedAt)).toBe(Math.floor(Date.parse(r.record_issued_at) / 1000))
	})

	test('a tampered API response stops the run before any chain read or write', () => {
		const { reads, writes } = mocks()
		const http = HttpActionsMock.testInstance()
		http.sendRequest = (req) => {
			if (req.url.endsWith('predge-keys.json')) return { statusCode: 200, body: readFileSync(here('fixtures/predge-keys.json')), headers: {} }
			const body = JSON.parse(fixture('2241873').toString())
			body.attestation.canonical = body.attestation.canonical.replace('"outcome":"No"', '"outcome":"Yes"')
			return { statusCode: 200, body: Buffer.from(JSON.stringify(body)), headers: {} }
		}
		expect(() => buildEvidence(runtimeWith(config), '2241873')).toThrow()
		expect(reads).toHaveLength(0)
		expect(writes).toHaveLength(0)
	})
})

describe('triggers', () => {
	test('HTTP trigger takes {"market_id"} and returns the full pack', () => {
		mocks()
		const out = JSON.parse(onHttp(runtimeWith(config), { input: Buffer.from('{"market_id":"2241873"}') } as never))
		expect(out.status).toBe('settled-differently')
		expect(out.pack.kind).toBe('predge-settlement-evidence-v1')
	})
	test('initWorkflow registers a cron and an HTTP handler', () => {
		expect(initWorkflow(config)).toHaveLength(2)
	})
})
