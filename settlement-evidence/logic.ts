// Verification of a Predge signed record. Pure functions, no CRE capability, so the same code runs
// inside the workflow (WASM) and in the unit tests (bun). @noble is used for ed25519 and sha256
// because the CRE runtime has no node:crypto.

import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'

// Canonical JSON, the rule Predge signs with (https://data.predge.io/canonicalization.md):
// keys sorted at every level, no insignificant whitespace, JSON.stringify for scalars.
export const canon = (v: unknown): string => {
	if (v === null || typeof v !== 'object') return JSON.stringify(v)
	if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
	const o = v as Record<string, unknown>
	return `{${Object.keys(o)
		.sort()
		.filter((k) => o[k] !== undefined)
		.map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
		.join(',')}}`
}

export const sha256Hex = (s: string): `0x${string}` => `0x${bytesToHex(sha256(utf8ToBytes(s)))}`

export type Attestation = {
	canonical: string
	signature: string
	public_key: string
	kid?: string
	content_hash?: string
	payload?: unknown
	algorithm?: string
}

export type KeySet = { keys: { kid: string; algorithm: string; public_key: string; active: boolean; role?: string }[] }

// Signed fields the evidence pack uses (all inside `canonical`, so all covered by the signature).
export type SignedFacts = {
	version: string
	issuer: string
	kind: string
	platform: string
	chain: string
	market_id: string
	condition_id: string
	uma_question_id: string
	adapter: string
	oracle: string
	uma_state: string
	resolved_on_chain: boolean
	paused: boolean
	open_dispute: boolean
	sent_to_uma_vote: boolean
	dispute_count: string
	current_proposal: string | null
	disputes: { disputed_at: string; disputed_proposal: string | null; tx: string }[]
	bulletin_board_count: string
	latest_bulletin_board_update: { kind: string; posted_at: string; poster: string } | null
	onchain_resolution: { outcome: string | null } | null
	risk_level: string
	recommendation: string
	checked_at: string
	issued_at: string
}

const strip0x = (h: string) => (h.startsWith('0x') ? h.slice(2) : h)
const lc = (h: string) => strip0x(h).toLowerCase()

/**
 * Verifies a Predge attestation and returns the signed facts and sha256(canonical).
 * Throws with a reason on any failure:
 *  1. the signer is the pinned Predge key (a valid signature from another key is rejected);
 *  2. if a key set is given, the key is listed there, active, ed25519, role "attestation", same kid;
 *  3. ed25519 over the exact UTF-8 bytes of `canonical` (strict RFC 8032, no ZIP-215 leniency);
 *  4. sha256(canonical) equals the published `content_hash`;
 *  5. `payload`, if it is an object, re-canonicalises to exactly `canonical`;
 *  6. the record is a settlement-risk record for the market that was asked for.
 */
export function verifyAttestation(a: Attestation, pinnedPublicKey: string, expectedMarketId: string, keySet?: KeySet) {
	if (!a || typeof a.canonical !== 'string' || typeof a.signature !== 'string' || typeof a.public_key !== 'string') {
		throw new Error('attestation missing canonical, signature or public_key')
	}
	if (a.algorithm !== undefined && a.algorithm !== 'ed25519') throw new Error(`unsupported algorithm ${a.algorithm}`)
	if (lc(a.public_key) !== lc(pinnedPublicKey)) throw new Error(`record signed by ${a.public_key}, not the pinned Predge key`)
	const kid = a.kid ?? lc(a.public_key).slice(0, 16)
	if (kid !== lc(a.public_key).slice(0, 16)) throw new Error(`kid ${kid} does not match public key`)
	if (keySet) {
		const k = keySet.keys.find((x) => x.kid === kid)
		if (!k) throw new Error(`kid ${kid} not in the Predge key set`)
		if (lc(k.public_key) !== lc(a.public_key)) throw new Error(`key set lists a different key for kid ${kid}`)
		if (!k.active || k.algorithm !== 'ed25519' || (k.role && k.role !== 'attestation')) {
			throw new Error(`kid ${kid} is not an active ed25519 attestation key`)
		}
	}
	const msg = utf8ToBytes(a.canonical)
	let sigOk = false
	try {
		sigOk = ed25519.verify(hexToBytes(strip0x(a.signature)), msg, hexToBytes(strip0x(a.public_key)), { zip215: false })
	} catch {
		sigOk = false
	}
	if (!sigOk) throw new Error('ed25519 signature does not verify over canonical')

	const contentHash = `0x${bytesToHex(sha256(msg))}` as `0x${string}`
	if (a.content_hash !== undefined && lc(a.content_hash) !== contentHash.slice(2)) {
		throw new Error(`content_hash mismatch: published ${a.content_hash}, computed ${contentHash}`)
	}
	if (a.payload !== undefined && typeof a.payload === 'object' && a.payload !== null && canon(a.payload) !== a.canonical) {
		throw new Error('payload does not re-canonicalise to canonical')
	}
	const facts = JSON.parse(a.canonical) as SignedFacts
	if (facts.kind !== 'settlement-risk') throw new Error(`record kind ${facts.kind}, expected settlement-risk`)
	if (String(facts.market_id) !== String(expectedMarketId)) {
		throw new Error(`record is for market ${facts.market_id}, asked for ${expectedMarketId}`)
	}
	return { facts, contentHash, kid }
}
