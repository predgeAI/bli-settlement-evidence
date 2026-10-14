# Predge Settlement Evidence: a Chainlink CRE workflow for disputed prediction-market outcomes

A [Chainlink Runtime Environment](https://docs.chain.link/cre) workflow that turns a Polymarket
market id into a **settlement evidence pack**: a small, deterministic JSON file a lawyer or a
compliance officer can file, cite and have re-checked. It says what was proposed, who disputed it
and when, whether it went to a UMA vote, what the final on-chain outcome is, and whether the outcome
differs from the disputed answer. It carries a plain-English summary. Every fact in it comes from a
signed record that every DON node verifies, and is cross-checked against the Polygon contract that
pays the market out. The pack's sha256 is written on chain by a DON-signed report.

## The problem

Prediction-market outcomes are settled by an optimistic oracle: someone proposes an answer, anyone
can dispute it, and a twice-disputed question goes to a UMA token-holder vote. When a dispute
changes the answer, people who traded on the proposal lose money, and the questions that follow are
legal ones: what was proposed, when was it disputed, what did the clarification say, when did the
outcome become final, and can you prove it.

The disputes are not rare. On Polymarket, from 1 January to 2 October 2026 (from Predge's scan of
UMA Optimistic Oracle and Polymarket UMA CTF adapter logs on Polygon):

- 3,005 disputes on 2,666 markets;
- of 2,543 disputed markets that have settled, 853 (33.5%) settled differently from the disputed
  proposal;
- at least $299M was traded on those answers.

Today the facts behind a claim are assembled by hand from block explorers and screenshots. Two
experts can disagree about what "the chain said" at a given time. A pack that anyone can re-verify,
with a hash anchored on chain at the time it was made, removes that argument.

## Who uses it

- **Litigation and arbitration counsel** on both sides of a disputed-settlement claim: a dated,
  verifiable exhibit for each market in the case.
- **Compliance officers** at brokers, funds and platforms that offer prediction-market exposure:
  evidence for a complaint file, a regulator query or a customer remediation decision; a cron run
  over a watch list catches markets that enter a dispute.
- **Expert witnesses and court-appointed experts**: `verify-pack.ts` re-checks a pack offline, and
  re-reads Polygon, without trusting Predge or the party that produced it.

## How it works

```
  HTTP trigger {"market_id": "2241873"}        cron (every 6 h, a watch list of markets)
                       \                         /
                        v                       v
 1  HTTP, every DON node     GET api.predge.io/v1/settlement-risk/<id>   + /.well-known/predge-keys.json
                             verify: signer = pinned Predge key, kid active in key set,
                             ed25519 over `canonical`, sha256(canonical) == content_hash
                             consensus: identical on every field
 2  EVM read, Polygon        Conditional Tokens 0x4D97…6045 (what Polymarket pays out through):
    mainnet (read only)      getOutcomeSlotCount, payoutDenominator, payoutNumerators(i)
                             at the last finalized block; must agree with the signed record
 3  build the pack           deterministic JSON + plain-English summary; pack_hash = sha256(canonical JSON)
 4  EVM write, Sepolia       DON-signed report {marketId, conditionId, packHash, recordContentHash,
    testnet                  status, disputeCount, openDispute, recordIssuedAt}
                             -> CRE forwarder -> SettlementEvidenceRegistry.onReport
```

CRE is the orchestration layer: one workflow joins an external API (Predge's signed records), a
blockchain read (Polygon) and a blockchain write (the registry), and it adds what a single script
cannot. Every node fetches and verifies the record independently, the nodes must agree field by field
before anything is built, and the on-chain anchor is a report signed by the DON, not by whoever ran
the check.

### Pack status

| code | status | meaning |
|---|---|---|
| 1 | `open-dispute` | a dispute is open; the outcome is not final |
| 2 | `unresolved` | no open dispute, not resolved on chain yet |
| 3 | `settled-as-proposed` | resolved to the disputed proposal |
| 4 | `settled-differently` | resolved to a different answer than the disputed proposal |
| 5 | `settled-undisputed` | resolved, never disputed |
| 6 | `record-chain-mismatch` | the signed record and the Polygon read disagree: do not rely on it |

### What is in a pack

`market` (ids, adapter, oracle), `resolution_process` (UMA state, current proposal, every dispute
with time, disputed answer and tx, whether it went to a UMA vote, bulletin-board updates), `outcome`
(open dispute, resolved, final outcome, first disputed proposal), `predge_assessment` (Predge's risk
level and recommendation, passed through unchanged), `polygon_ctf_check` (the raw CTF reading and
whether it agrees), `provenance` (signer kid and public key, signature, content hash, the **exact
signed record bytes**, issue and check times, key set and canonicalization links), `summary`.

Question text, slug and end date are Polymarket metadata relayed by the API. They are **not**
covered by the Predge signature, and the pack says so (`market_metadata_unsigned`).

The summary is built by deterministic code, with no LLM and no API keys, so it is the same on every
node and the pack hash is reproducible. Example (market 2241873, from `logs/pack-2241873.json`):

> Polymarket market 2241873 ("Iran closes its airspace by May 24?"). The proposed answer "Yes" was
> disputed twice, first on 2026-05-22 23:26 UTC (tx 0x537d7b36…). The question was sent to a UMA
> token-holder vote. The market resolved on chain to "No", which differs from the disputed proposal
> "Yes". An independent read of the Polygon Conditional Tokens contract confirms the condition is
> resolved (payouts [0, 1] / 1). Source: Predge record signed with ed25519 key 13fa3d18a369e6c7,
> content hash 0x6866c81b…60cf, checked against the chain at 2026-10-14 13:25 UTC. This pack
> records on-chain facts; it is not legal advice and not an opinion on the merits.

## Layout

| Path | What it is |
|---|---|
| `settlement-evidence/workflow.ts` | The workflow: HTTP + cron triggers, HTTP fetch with consensus, Polygon CTF read, pack, DON report write. |
| `settlement-evidence/logic.ts` | Verification: canonical JSON, ed25519 (`@noble/curves`, strict RFC 8032), sha256, key-set check. |
| `settlement-evidence/evidence.ts` | Pack builder, status, CTF cross-check, deterministic summary. |
| `settlement-evidence/*.test.ts` | 19 unit tests (real signed records as fixtures, mocked chain). |
| `settlement-evidence/scripts/verify-pack.ts` | Independent re-check of a pack (signature, rebuild, hash, optional live Polygon read). |
| `settlement-evidence/scripts/check-registry.ts` | `eth_simulateV1` on Sepolia: the registry accepts the workflow's report from the forwarder only. |
| `settlement-evidence/scripts/extract-pack.ts` | Pulls the pack out of a saved simulator log. |
| `settlement-evidence/config.staging.json` | Watch list, pinned key, Polygon CTF, write target (zero address = no write). |
| `settlement-evidence/config.write-demo.json` | Same, with a placeholder receiver so the simulator exercises the report path. |
| `contracts/SettlementEvidenceRegistry.sol` | Consumer: accepts reports only from the CRE forwarder, stores entries by pack hash, `isAnchored(packHash)`. |
| `contracts/deploy.mjs` | Compile, and with your own Sepolia key deploy. Dry run by default. |
| `logs/` | Saved simulator output, extracted packs, verification output (14 Oct 2026). |

## How to run

Requirements: [CRE CLI](https://docs.chain.link/cre/getting-started/cli-installation) (tested with
v1.30.0) and `cre login`, Bun 1.3, Node 20.

```bash
cd settlement-evidence && bun install && bun test && cd ..
cp .env.example .env   # then set CRE_ETH_PRIVATE_KEY: without --broadcast any 32-byte hex value works

# one market, HTTP trigger (open dispute / overturned)
cre workflow simulate ./settlement-evidence --target staging-settings --non-interactive \
  --trigger-index 1 --http-payload '{"market_id":"5219930"}'
cre workflow simulate ./settlement-evidence --target staging-settings --non-interactive \
  --trigger-index 1 --http-payload '{"market_id":"2241873"}'

# same, exercising the DON report + write path (dry run, nothing is sent)
cre workflow simulate ./settlement-evidence --target staging-settings --non-interactive \
  --trigger-index 1 --http-payload '{"market_id":"2241873"}' --config config.write-demo.json

# cron trigger over the watch list
cre workflow simulate ./settlement-evidence --target staging-settings --non-interactive --trigger-index 0

# independent checks
(cd contracts && npm install && node deploy.mjs)          # compile the registry (dry run)
cd settlement-evidence
bun scripts/extract-pack.ts ../logs/simulate-http-2241873.log > ../logs/pack-2241873.json
bun scripts/verify-pack.ts ../logs/pack-2241873.json --rpc https://polygon-bor-rpc.publicnode.com
bun scripts/check-registry.ts ../logs/pack-2241873.json
```

To anchor on Sepolia for real: fund a throwaway Sepolia key, deploy with
`PRIVATE_KEY=0x… CONFIRM_TESTNET=yes node contracts/deploy.mjs --send`, put the address in
`write.receiverAddress`, set `CRE_ETH_PRIVATE_KEY` in `.env`, and add `--broadcast`.

## What was run, and what it printed (14 Oct 2026)

### Unit tests

```
$ cd settlement-evidence && bun test
 19 pass
 0 fail
 49 expect() calls
Ran 19 tests across 2 files.
```

Covered: both real records verify against the pinned key and the key set; an edited record, a
corrupted signature, another signer, a wrong content hash, a record for another market, a key
missing from or inactive in the key set, and an unsigned field slipped into `payload` are all
rejected; open-dispute and settled-differently packs from the real records; the embedded signed
record re-verifies on its own; the pack hash is deterministic and changes with any field; record vs
Polygon disagreement gives `record-chain-mismatch` (three ways); the DON report decodes to the pack
hash and status; a tampered API response stops the run before any chain read or write.

### `cre workflow simulate`, open dispute: market 5219930

Full output: [`logs/simulate-http-5219930.log`](logs/simulate-http-5219930.log), pack:
[`logs/pack-5219930.json`](logs/pack-5219930.json).

```
[USER LOG] [5219930] signed record verified on every node (pinned key 13fa3d18a369e6c7, key set, ed25519, sha256), consensus reached: uma_state=disputed open_dispute=true disputes=2 outcome=- content_hash=0x533d1b8bfab40bfd352c7febbf4a8d2ed04a82dba5f97ef3e982f23a5483d3b6
[USER LOG] [5219930] Polygon CTF 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045 condition 0x50d446794ad4e7b16e27e248ed841c76ca7edbb084907f61cd5a9d1f83cf96a8: slots=2 payoutDenominator=0 payoutNumerators=[0,0]
[USER LOG] [5219930] evidence pack status=open-dispute pack_hash=0x6e3cb184263dd45beee06f7ced13dca80afa29ea2a7ff136f1ef9773091ba51b
[USER LOG] [5219930] summary: Polymarket market 5219930 ("Will Trump say "Ammunition" this week?"). The proposed answer "No" was disputed twice, first on 2026-10-12 08:18 UTC (tx 0x7a19f69e…). The question was sent to a UMA token-holder vote. The question creator posted a clarification on the bulletin board on 2026-10-12 20:15 UTC. A dispute is open at the time of this record, so the outcome is not final and the market has not paid out. …
[USER LOG] [5219930] DON-signed report (pack_hash, status=1) prepared, dry run (no --broadcast, nothing sent) to 0x000000000000000000000000000000000000bEEF on ethereum-testnet-sepolia
✓ Workflow Simulation Result: …
```

### `cre workflow simulate`, overturned: market 2241873 (disputed "Yes", final "No")

Full output: [`logs/simulate-http-2241873.log`](logs/simulate-http-2241873.log), pack:
[`logs/pack-2241873.json`](logs/pack-2241873.json).

```
[USER LOG] [2241873] signed record verified on every node (pinned key 13fa3d18a369e6c7, key set, ed25519, sha256), consensus reached: uma_state=settled open_dispute=false disputes=2 outcome=No content_hash=0x6866c81b995582302261b57377de7da19fb621a1426d36499fc03d8ce06860cf
[USER LOG] [2241873] Polygon CTF 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045 condition 0x4ba348328e4d4ddee9e6734c9a369b2e8138611651f9f6dc8f59dea51df6c734: slots=2 payoutDenominator=1 payoutNumerators=[0,1]
[USER LOG] [2241873] evidence pack status=settled-differently pack_hash=0x014519c28508b2f1e54cf04d5d99e775dd2d457feb5b1c6a1679d11ac11ec4ae
[USER LOG] [2241873] DON-signed report (pack_hash, status=4) prepared, dry run (no --broadcast, nothing sent) to 0x000000000000000000000000000000000000bEEF on ethereum-testnet-sepolia
```

The cron trigger over both markets: [`logs/simulate-cron-both.log`](logs/simulate-cron-both.log).

### Independent re-check of the packs

```
$ bun scripts/verify-pack.ts ../logs/pack-2241873.json --rpc https://polygon-bor-rpc.publicnode.com
1. signed record: OK (key 13fa3d18a369e6c7, ed25519 verified, sha256 0x6866c81b995582302261b57377de7da19fb621a1426d36499fc03d8ce06860cf)
2. pack rebuilt from the signed record: identical
3. pack_hash 0x014519c28508b2f1e54cf04d5d99e775dd2d457feb5b1c6a1679d11ac11ec4ae  status settled-differently
4. Polygon now: payoutDenominator=1 (pack recorded 1)

$ bun scripts/check-registry.ts ../logs/pack-2241873.json
onReport from MockKeystoneForwarder: status 0x1, gasUsed 687349
  EvidenceAnchored {"packHash":"0x014519c2…c4ae","conditionId":"0x4ba34832…c734","marketId":"2241873","status":4,"openDispute":false,"recordContentHash":"0x6866c81b…60cf","recordIssuedAt":"1791984319"}
onReport from any other sender: status 0x0 (execution reverted)
```

The pack hash from the simulator, from the offline rebuild and in the registry event are the same.
Both markets: [`logs/verify-5219930.log`](logs/verify-5219930.log), [`logs/verify-2241873.log`](logs/verify-2241873.log).

## Limitations, stated plainly

- **Simulation only, no on-chain anchor yet.** The report is built and signed by the simulator and
  the write path runs, but without `--broadcast` nothing is sent (the log says "dry run"). The
  registry is not deployed: the test key has no Sepolia ETH. `check-registry.ts` shows, by
  `eth_simulateV1` with the compiled code, that the registry accepts that exact report from the
  Sepolia MockKeystoneForwarder and rejects any other sender. The receiver `0x…bEEF` in
  `config.write-demo.json` is a placeholder.
- **Not deployed to a DON.** `cre whoami` shows deploy access not enabled for the account. A
  deployment also needs the production KeystoneForwarder as the registry's forwarder and
  `authorizedKeys` on the HTTP trigger (it is `{}` here, which only suits simulation).
- **Consensus on the record relies on the HTTP cache.** Predge signs a fresh record (new
  `issued_at`) on every request, so the request sets `cacheSettings: {store: true, maxAge: "60s"}`
  for all nodes to verify the same bytes. If nodes did not share it, identical-field consensus would
  fail and the run would error: it fails closed.
- **The pack is a snapshot.** It states facts as of `record_checked_at`. An open dispute can settle
  later; `verify-pack.ts --rpc` reports when Polygon has changed since. Each run makes a new pack
  with a new hash; the registry keeps all of them and the latest per condition.
- **Outcome-label check only for Yes/No markets.** The CTF read checks resolved/unresolved for every
  market, and the winning index for binary markets with the Polymarket convention
  `["Yes", "No"]` = indexes 0, 1. Other outcome labels are marked `not-checked`.
- **What a rebuild proves.** `verify-pack.ts` proves the pack follows from the signed record and the
  recorded CTF reading. It does not prove the CTF reading was what the chain said at that time; the
  DON consensus does that, and the on-chain anchor dates it.
- `risk_level` and `recommendation` are Predge's reading of chain facts, passed through unchanged.
  Nothing in the pack is legal advice or an opinion on the merits.
- The trust anchor is in config: the Predge ed25519 key `13fa3d18…52d9` (kid `13fa3d18a369e6c7`),
  also checked against `https://api.predge.io/.well-known/predge-keys.json`. Canonicalization:
  `https://data.predge.io/canonicalization.md`.
- No LLM is used. An LLM summary could be added as an optional extra on top of the deterministic one,
  but it would not be part of the hashed pack unless every node produced the same text.

## Toolchain

CRE CLI v1.30.0, Bun 1.3, `@chainlink/cre-sdk` 1.23.0, viem 2.34.0, `@noble/curves` 2.0.1,
`@noble/hashes` 2.0.1, zod 3.25.76; solc 0.8.26 and ethers 6.17 for the contract. Polygon is read
through `polygon-bor-rpc.publicnode.com`, Sepolia through `ethereum-sepolia-rpc.publicnode.com`.

License: MIT.
