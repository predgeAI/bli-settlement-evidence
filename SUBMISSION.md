# DoraHacks BUIDL draft: BLI Legal Tech Hackathon 2

DRAFT. Not submitted. Deadline: 01 Nov 2026 01:01 UTC (the site shows 2026/11/01 04:01 in UTC+3).

## Fields

**BUIDL name:** Predge Settlement Evidence

**One-liner (tagline):** A Chainlink CRE workflow that turns a disputed Polymarket market into a
verifiable evidence pack for lawyers and compliance teams, anchored on chain by a DON-signed report.

**Tracks:** LegalTech & RegTech (primary), AI x Blockchain

**Bounties to select:**
- Chainlink "Best workflow with CRE" (bounty 1362): yes.
- RYO-CHAN "Autonomous Agents" (bounty 1380): **no, not as is.** That bounty asks for agents that
  "interpret market evidence and record the practice trades they would make", with a reasoning
  trail. Our workflow produces evidence and makes no trading decision. Fitting it would mean a new
  agent that opens practice positions on disputed markets (sizing, exit rules, a trade log), which
  is a different product and several hours of extra work. Adding it as is would be a weak, off-brief
  entry. Revisit only if there is time left after the video: a "dispute-aware practice trader" that
  reads the pack status and logs the paper trade it would make.

**Links (placeholders):**
- GitHub: https://github.com/predgeAI/bli-settlement-evidence
- Demo video: `https://youtu.be/<id>` (TODO)
- Sample evidence packs: `logs/pack-5219930.json`, `logs/pack-2241873.json` in the repo
- Predge API: https://api.predge.io/v1/settlement-risk/2241873
- Predge key set: https://api.predge.io/.well-known/predge-keys.json
- Website: https://predge.io

## Description

### Problem

Prediction-market outcomes are settled by an optimistic oracle: someone proposes an answer, anyone
can dispute it, and a twice-disputed question goes to a UMA token-holder vote. When a dispute
changes the answer, traders who acted on the proposal lose money, and the questions that follow are
legal ones: what was proposed, when was it disputed, what did the clarification say, when did the
outcome become final, and can you prove it.

On Polymarket, from 1 January to 2 October 2026, there were 3,005 disputes on 2,666 markets. Of the
2,543 disputed markets that have settled, 853 (33.5%) settled differently from the disputed
proposal, and at least $299M was traded on those answers. Today the facts behind such a claim are
pieced together by hand from block explorers and screenshots, and the two sides' experts can
disagree about what the chain said and when.

### What we built

A Chainlink CRE workflow, `settlement-evidence`. Input: a Polymarket market id (HTTP trigger, or a
cron over a watch list). Output: an **evidence pack**, a compact JSON exhibit with:

- the market and its on-chain identifiers;
- the resolution process: the proposal, every dispute with time, disputed answer and transaction,
  whether the question went to a UMA vote, bulletin-board clarifications;
- the final on-chain outcome and whether it differs from the disputed proposal;
- an independent read of the Polygon Conditional Tokens contract that pays the market out;
- provenance: the exact signed Predge record, signer key id, signature, content hash, timestamps;
- a plain-English summary, produced by deterministic code (no LLM, no API keys).

The pack's sha256 and status (open dispute / settled as proposed / settled differently / …) are
written on chain by a DON-signed report to a registry contract. Anyone holding the pack can recompute
the hash, look it up, and re-verify every fact with the included script, without trusting Predge or
the party that produced it.

### Who it is for

Litigation and arbitration counsel (a dated, verifiable exhibit per market), compliance teams at
brokers, funds and platforms with prediction-market exposure (complaint files, regulator queries,
remediation decisions; the cron run flags markets that enter a dispute), and expert witnesses.

### Results (CRE CLI simulation, 14 Oct 2026)

- Market 5219930, "Will Trump say "Ammunition" this week?": proposal "No" disputed twice, sent to a
  UMA vote, open dispute. Polygon CTF: not paid out. Status `open-dispute`.
- Market 2241873, "Iran closes its airspace by May 24?": proposal "Yes" disputed twice, UMA vote,
  final outcome "No". Polygon CTF pays outcome index 1 ("No"). Status `settled-differently`.
- 19 unit tests pass. The registry accepts the workflow's report from the CRE forwarder and rejects
  any other sender (checked by `eth_simulateV1` on Sepolia with the compiled contract).

## How CRE is used

CRE is the orchestration layer of the project; nothing else coordinates the steps.

1. **HTTP capability, node mode, consensus.** Every DON node fetches Predge's signed record and the
   Predge key set, and verifies: the signer is the pinned key, the key id is active in the key set,
   the ed25519 signature over the canonical bytes is valid, and sha256 equals the published content
   hash. Nodes then reach consensus with identical-per-field aggregation; a tampered or mismatched
   response stops the run before any chain access.
2. **EVM read capability (Polygon mainnet, read only).** `getOutcomeSlotCount`, `payoutDenominator`
   and `payoutNumerators` on the Conditional Tokens contract at the last finalized block. The
   workflow requires the chain and the signed record to agree, or the pack is marked
   `record-chain-mismatch`.
3. **Deterministic compute.** The pack and the summary are built from the agreed data, so every node
   produces the same bytes and the same hash.
4. **Report + EVM write capability (Sepolia testnet).** `runtime.report` produces a DON-signed report
   (market id, condition id, pack hash, record hash, status, dispute count, open-dispute flag, record
   time) delivered through the CRE forwarder to `SettlementEvidenceRegistry.onReport`, which only
   accepts the forwarder.
5. **Triggers.** HTTP trigger for one market on demand (the caller gets the full pack back), cron for
   a compliance watch list.

Simulated with `cre workflow simulate` (CRE CLI v1.30.0); logs for both markets are in `logs/`.

## Honest status (keep in the BUIDL text)

- CRE CLI simulation, not a DON deployment (the account does not have deploy access yet).
- The report and write path run in the simulator as a dry run; nothing has been broadcast and the
  registry is not deployed yet (no testnet funds on the key).
- The pack is a snapshot as of the record's check time; a later run produces a new pack.
- Not legal advice; the pack records on-chain facts and Predge's risk label, passed through.

## Video script (about 2 min 30 s)

**0:00–0:20. The problem.** (Screen: a Polymarket market page, then the UMA dispute.)
"When a prediction market is disputed, the answer can change. From January to early October 2026, of 2,543 disputed Polymarket
markets that settled, 853, a third, settled differently from the disputed answer, with at least
$299M traded on those answers. When that ends up in a complaint or an arbitration, someone has to
prove what was proposed, when it was disputed and what the chain finally said."

**0:20–0:40. The product.** (Screen: README diagram.)
"Predge Settlement Evidence is a Chainlink CRE workflow. Give it a market id; it returns an evidence
pack a lawyer can file, and anchors its hash on chain with a report signed by the oracle network."

**0:40–1:30. Live run, overturned market.** (Terminal.)
Run `cre workflow simulate ... --http-payload '{"market_id":"2241873"}' --config config.write-demo.json`.
Point at each line: "Every node fetches the signed record and verifies the signature, the key and
the hash, and they agree. Then it reads the Conditional Tokens contract on Polygon: paid out to
outcome 1, that's No. The pack says: disputed Yes, sent to a UMA vote, settled No, settled
differently. Here is the summary in plain English. And here the DON-signed report with the pack hash
goes to the registry; in this simulation it is a dry run."

**1:30–1:50. Open dispute.** Run the same for 5219930. "Same workflow, a market that is still
under dispute: open dispute, not paid out on Polygon, so the pack says the outcome is not final."

**1:50–2:15. Anyone can check it.** Run `verify-pack.ts` and `check-registry.ts`.
"The other side's expert does not need to trust us. The pack contains the exact signed record. This
script re-verifies it, rebuilds the pack, gets the same hash, and re-reads Polygon. And the registry
accepts the report only from the Chainlink forwarder."

**2:15–2:30. Close.** (Screen: pack JSON + status table.)
"For litigators, compliance teams and expert witnesses: a dated, verifiable record of how a disputed
market was settled. Built on Chainlink CRE. Predge."

## Before submitting (checklist)

- [x] Repo public: https://github.com/predgeAI/bli-settlement-evidence (14 Oct).
- [ ] Optional: fund a throwaway Sepolia key, deploy the registry, run once with `--broadcast`, add
      the tx link to the README and here.
- [ ] Record the video (2–3 min) and upload.
- [ ] Register on DoraHacks, create the BUIDL, select both tracks and the CRE bounty.
- [ ] Re-run the two simulations close to the deadline if market 5219930 settles (the pack would
      change to settled-as-proposed or settled-differently; the saved logs stay as dated evidence).
