// Builds the settlement evidence pack: a compact, deterministic JSON document a lawyer or a
// compliance officer can file, cite and re-check. Pure functions: same input, same bytes, same hash
// on every DON node.

import { canon, sha256Hex, type SignedFacts } from './logic'

// Polygon read of the Gnosis Conditional Tokens (CTF) contract Polymarket settles through.
export type CtfReading = {
	contract: string
	outcome_slot_count: number
	payout_denominator: string // "0" while the condition is unresolved
	payout_numerators: string[]
}

export type UnsignedMetadata = { question: string; slug: string; end_date: string }

export type SignerInfo = { kid: string; public_key: string; signature: string; content_hash: `0x${string}`; canonical: string }

export const PACK_STATUS = {
	'open-dispute': 1, // a dispute is open; the outcome is not final
	unresolved: 2, // no open dispute, but not resolved on chain yet
	'settled-as-proposed': 3, // resolved on chain to the (first) disputed proposal
	'settled-differently': 4, // resolved on chain to a different answer than the disputed proposal
	'settled-undisputed': 5, // resolved on chain, never disputed
	'record-chain-mismatch': 6, // the signed record and the Polygon CTF read disagree: do not rely on it
} as const
export type PackStatus = keyof typeof PACK_STATUS

// Polymarket binary markets list outcomes as ["Yes", "No"]: index 0 = Yes, index 1 = No.
const BINARY_INDEX: Record<string, number> = { Yes: 0, No: 1 }

export function ctfCheck(f: SignedFacts, c: CtfReading) {
	const resolvedOnCtf = BigInt(c.payout_denominator) > 0n
	const winners = c.payout_numerators.map((n, i) => (BigInt(n) > 0n ? i : -1)).filter((i) => i >= 0)
	const outcome = f.onchain_resolution?.outcome ?? null
	let label: 'agrees' | 'disagrees' | 'not-checked' = 'not-checked'
	if (resolvedOnCtf && outcome && c.outcome_slot_count === 2 && outcome in BINARY_INDEX) {
		label = winners.length === 1 && winners[0] === BINARY_INDEX[outcome] ? 'agrees' : 'disagrees'
	}
	const resolutionAgrees = resolvedOnCtf === Boolean(f.resolved_on_chain)
	return {
		resolved_on_ctf: resolvedOnCtf,
		winning_outcome_indexes: winners,
		resolution_state_agrees_with_record: resolutionAgrees,
		outcome_label_check: label,
		agrees_with_record: resolutionAgrees && label !== 'disagrees',
	}
}

export function packStatus(f: SignedFacts, agrees: boolean): PackStatus {
	if (!agrees) return 'record-chain-mismatch'
	if (f.open_dispute) return 'open-dispute'
	if (!f.resolved_on_chain || !f.onchain_resolution?.outcome) return 'unresolved'
	const first = f.disputes?.[0]?.disputed_proposal
	if (!first) return 'settled-undisputed'
	return f.onchain_resolution.outcome === first ? 'settled-as-proposed' : 'settled-differently'
}

const day = (iso: string) => iso.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, ' UTC')
const q = (s: string | null | undefined) => (s ? `"${s}"` : 'none')
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)

/** Deterministic plain-English summary. No LLM, no keys, same text on every node. */
export function summarize(f: SignedFacts, meta: UnsignedMetadata, status: PackStatus, ctf: ReturnType<typeof ctfCheck>, c: CtfReading, s: SignerInfo): string {
	const parts: string[] = []
	parts.push(`Polymarket market ${f.market_id}${meta.question ? ` ("${meta.question}")` : ''}.`)
	const n = Number(f.dispute_count || '0')
	const first = f.disputes?.[0]
	if (n > 0 && first) {
		parts.push(
			`The proposed answer ${q(first.disputed_proposal)} was disputed ${times(n)}, first on ${day(first.disputed_at)} (tx ${first.tx.slice(0, 10)}…).`,
		)
		if (f.sent_to_uma_vote) parts.push('The question was sent to a UMA token-holder vote.')
	} else {
		parts.push('No dispute is recorded for this market.')
	}
	if (f.latest_bulletin_board_update) {
		const b = f.latest_bulletin_board_update
		parts.push(`The ${b.poster.replace(/_/g, ' ')} posted a ${b.kind} on the bulletin board on ${day(b.posted_at)}.`)
	}
	const outcome = f.onchain_resolution?.outcome
	switch (status) {
		case 'open-dispute':
			parts.push('A dispute is open at the time of this record, so the outcome is not final and the market has not paid out.')
			break
		case 'unresolved':
			parts.push('No dispute is open, but the market is not resolved on chain yet.')
			break
		case 'settled-as-proposed':
			parts.push(`The market resolved on chain to ${q(outcome)}, the same answer that was disputed.`)
			break
		case 'settled-differently':
			parts.push(`The market resolved on chain to ${q(outcome)}, which differs from the disputed proposal ${q(first?.disputed_proposal)}.`)
			break
		case 'settled-undisputed':
			parts.push(`The market resolved on chain to ${q(outcome)}.`)
			break
		case 'record-chain-mismatch':
			parts.push('WARNING: the signed record and the Polygon contract read disagree; do not rely on this pack.')
			break
	}
	parts.push(
		ctf.resolved_on_ctf
			? `An independent read of the Polygon Conditional Tokens contract confirms the condition is resolved (payouts [${c.payout_numerators.join(', ')}] / ${c.payout_denominator}).`
			: 'An independent read of the Polygon Conditional Tokens contract confirms the condition has not paid out (payout denominator 0).',
	)
	parts.push(
		`Source: Predge record signed with ed25519 key ${s.kid}, content hash ${s.content_hash}, checked against the chain at ${day(f.checked_at)}. This pack records on-chain facts; it is not legal advice and not an opinion on the merits.`,
	)
	return parts.join(' ')
}

export function buildPack(f: SignedFacts, meta: UnsignedMetadata, c: CtfReading, s: SignerInfo) {
	const ctf = ctfCheck(f, c)
	const status = packStatus(f, ctf.agrees_with_record)
	const pack = {
		kind: 'predge-settlement-evidence-v1',
		status,
		market: {
			platform: f.platform,
			chain: f.chain,
			market_id: f.market_id,
			condition_id: f.condition_id,
			uma_question_id: f.uma_question_id,
			adapter: f.adapter,
			oracle: f.oracle,
		},
		market_metadata_unsigned: {
			...meta,
			note: 'Question text, slug and end date come from Polymarket metadata relayed by api.predge.io; they are not covered by the Predge signature.',
		},
		resolution_process: {
			uma_state: f.uma_state,
			current_proposal: f.current_proposal,
			dispute_count: Number(f.dispute_count || '0'),
			disputes: (f.disputes || []).map((d) => ({ disputed_at: d.disputed_at, disputed_proposal: d.disputed_proposal, tx: d.tx })),
			sent_to_uma_vote: f.sent_to_uma_vote,
			paused: f.paused,
			bulletin_board_count: Number(f.bulletin_board_count || '0'),
			latest_bulletin_board_update: f.latest_bulletin_board_update,
		},
		outcome: {
			open_dispute: f.open_dispute,
			resolved_on_chain: f.resolved_on_chain,
			final_outcome: f.onchain_resolution?.outcome ?? null,
			first_disputed_proposal: f.disputes?.[0]?.disputed_proposal ?? null,
		},
		predge_assessment: { risk_level: f.risk_level, recommendation: f.recommendation },
		polygon_ctf_check: { ...c, ...ctf, read_at: 'last finalized Polygon block' },
		provenance: {
			issuer: f.issuer,
			record_version: f.version,
			signer_kid: s.kid,
			public_key: s.public_key,
			algorithm: 'ed25519',
			signature: s.signature,
			content_hash: s.content_hash,
			record_checked_at: f.checked_at,
			record_issued_at: f.issued_at,
			key_set: 'https://api.predge.io/.well-known/predge-keys.json',
			canonicalization: 'https://data.predge.io/canonicalization.md',
			signed_record_canonical: s.canonical, // the exact bytes Predge signed: re-verify with public_key + signature
			verified_by_every_node: ['signer is the pinned Predge key', 'kid active in key set', 'ed25519 signature', 'sha256(canonical) == content_hash'],
		},
		summary: '',
	}
	pack.summary = summarize(f, meta, status, ctf, c, s)
	const bytes = canon(pack)
	return { pack, canonical: bytes, packHash: sha256Hex(bytes), status }
}
