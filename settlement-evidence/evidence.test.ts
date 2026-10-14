import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { buildPack, type CtfReading, packStatus } from './evidence'
import { type Attestation, canon, type KeySet, type SignedFacts, verifyAttestation } from './logic'

const here = (p: string) => path.join(import.meta.dir, p)
const PINNED = '13fa3d18a369e6c71bf941563ba47822b30182273d5106a0e8fb61c5016352d9'
const record = (m: string) => JSON.parse(readFileSync(here(`fixtures/settlement-risk-${m}.json`), 'utf8'))
const keys = JSON.parse(readFileSync(here('fixtures/predge-keys.json'), 'utf8')) as KeySet
const att = (m: string) => record(m).attestation as Attestation
const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'
const unresolvedCtf: CtfReading = { contract: CTF, outcome_slot_count: 2, payout_denominator: '0', payout_numerators: ['0', '0'] }
const noWonCtf: CtfReading = { contract: CTF, outcome_slot_count: 2, payout_denominator: '1', payout_numerators: ['0', '1'] }
const meta = (m: string) => ({ question: record(m).market.question, slug: record(m).market.slug, end_date: record(m).market.end_date })
const signer = (m: string, contentHash: `0x${string}`) => ({ kid: '13fa3d18a369e6c7', public_key: PINNED, signature: att(m).signature, content_hash: contentHash, canonical: att(m).canonical })

describe('verifyAttestation', () => {
	test('real records from api.predge.io verify against the pinned key and the key set', () => {
		for (const m of ['5219930', '2241873']) {
			const v = verifyAttestation(att(m), PINNED, m, keys)
			expect(v.kid).toBe('13fa3d18a369e6c7')
			expect(v.contentHash.slice(2)).toBe(att(m).content_hash!)
			expect(v.facts.market_id).toBe(m)
		}
	})
	test('a record edited after signing is rejected', () => {
		const a = { ...att('2241873'), canonical: att('2241873').canonical.replace('"outcome":"No"', '"outcome":"Yes"'), content_hash: undefined }
		expect(() => verifyAttestation(a, PINNED, '2241873')).toThrow('signature')
	})
	test('a corrupted signature is rejected', () => {
		const a = att('2241873')
		const sig = (a.signature[0] === '0' ? '1' : '0') + a.signature.slice(1)
		expect(() => verifyAttestation({ ...a, signature: sig }, PINNED, '2241873')).toThrow('signature')
	})
	test('a different signer is rejected even if the signature is valid for it', () => {
		const other = 'a122cc095c0f7fe52645be73dd496498a2d10f7018e85db2f9d721f0a3d997e4'
		expect(() => verifyAttestation({ ...att('2241873'), public_key: other, kid: other.slice(0, 16) }, PINNED, '2241873')).toThrow('pinned')
	})
	test('a wrong content_hash is rejected', () => {
		expect(() => verifyAttestation({ ...att('2241873'), content_hash: '00'.repeat(32) }, PINNED, '2241873')).toThrow('content_hash')
	})
	test('a record for another market is rejected', () => {
		expect(() => verifyAttestation(att('2241873'), PINNED, '5219930')).toThrow('asked for')
	})
	test('a key that is missing from the key set, or inactive, is rejected', () => {
		expect(() => verifyAttestation(att('2241873'), PINNED, '2241873', { keys: [] })).toThrow('not in the Predge key set')
		const inactive = { keys: keys.keys.map((k) => ({ ...k, active: false })) }
		expect(() => verifyAttestation(att('2241873'), PINNED, '2241873', inactive)).toThrow('not an active')
	})
	test('an unsigned field slipped into payload is rejected', () => {
		const a = att('2241873')
		const payload = { ...JSON.parse(a.canonical), risk_level: 'low' }
		expect(() => verifyAttestation({ ...a, payload }, PINNED, '2241873')).toThrow('payload')
	})
})

describe('evidence pack', () => {
	test('open dispute (5219930): status open-dispute, CTF not paid out, summary says not final', () => {
		const v = verifyAttestation(att('5219930'), PINNED, '5219930')
		const { pack, status, packHash } = buildPack(v.facts, meta('5219930'), unresolvedCtf, signer('5219930', v.contentHash))
		expect(status).toBe('open-dispute')
		expect(pack.polygon_ctf_check.agrees_with_record).toBe(true)
		expect(pack.resolution_process.dispute_count).toBe(2)
		expect(pack.summary).toContain('disputed twice')
		expect(pack.summary).toContain('not final')
		expect(packHash).toMatch(/^0x[0-9a-f]{64}$/)
	})
	test('overturned (2241873): disputed Yes, final No -> settled-differently, CTF pays index 1', () => {
		const v = verifyAttestation(att('2241873'), PINNED, '2241873')
		const { pack, status } = buildPack(v.facts, meta('2241873'), noWonCtf, signer('2241873', v.contentHash))
		expect(status).toBe('settled-differently')
		expect(pack.outcome).toEqual({ open_dispute: false, resolved_on_chain: true, final_outcome: 'No', first_disputed_proposal: 'Yes' })
		expect(pack.polygon_ctf_check.outcome_label_check).toBe('agrees')
		expect(pack.summary).toContain('which differs from the disputed proposal "Yes"')
	})
	test('the pack embeds the signed record, which re-verifies on its own', () => {
		const v = verifyAttestation(att('2241873'), PINNED, '2241873')
		const { pack } = buildPack(v.facts, meta('2241873'), noWonCtf, signer('2241873', v.contentHash))
		const p = pack.provenance
		const again = verifyAttestation({ canonical: p.signed_record_canonical, signature: p.signature, public_key: p.public_key, content_hash: p.content_hash }, PINNED, '2241873')
		expect(again.contentHash).toBe(v.contentHash)
	})
	test('the pack hash is deterministic and changes with any field', () => {
		const v = verifyAttestation(att('2241873'), PINNED, '2241873')
		const a = buildPack(v.facts, meta('2241873'), noWonCtf, signer('2241873', v.contentHash))
		const b = buildPack(JSON.parse(JSON.stringify(v.facts)), meta('2241873'), { ...noWonCtf }, signer('2241873', v.contentHash))
		expect(b.packHash).toBe(a.packHash)
		expect(b.canonical).toBe(canon(a.pack))
		const c = buildPack(v.facts, { ...meta('2241873'), question: 'edited' }, noWonCtf, signer('2241873', v.contentHash))
		expect(c.packHash).not.toBe(a.packHash)
	})
	test('record and Polygon disagree -> record-chain-mismatch, with a warning in the summary', () => {
		const v = verifyAttestation(att('2241873'), PINNED, '2241873')
		const notPaid = buildPack(v.facts, meta('2241873'), unresolvedCtf, signer('2241873', v.contentHash))
		expect(notPaid.status).toBe('record-chain-mismatch')
		expect(notPaid.pack.summary).toContain('WARNING')
		const wrongWinner = buildPack(v.facts, meta('2241873'), { ...noWonCtf, payout_numerators: ['1', '0'] }, signer('2241873', v.contentHash))
		expect(wrongWinner.status).toBe('record-chain-mismatch')
		const v2 = verifyAttestation(att('5219930'), PINNED, '5219930')
		expect(buildPack(v2.facts, meta('5219930'), noWonCtf, signer('5219930', v2.contentHash)).status).toBe('record-chain-mismatch')
	})
	test('other statuses', () => {
		const f = JSON.parse(att('2241873').canonical) as SignedFacts
		expect(packStatus({ ...f, onchain_resolution: { outcome: 'Yes' } }, true)).toBe('settled-as-proposed')
		expect(packStatus({ ...f, disputes: [], dispute_count: '0' }, true)).toBe('settled-undisputed')
		expect(packStatus({ ...f, resolved_on_chain: false, onchain_resolution: null }, true)).toBe('unresolved')
	})
})
