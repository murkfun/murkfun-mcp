# Signed orders and the holder set

Every user action on MurkFun is a **signed order**: the user's wallet signs exactly that order, the user's agent
proves locally that the signer is a SPACE ID Agent ID holder, and a relayer (or a privacy pool) submits the order with
its proof. No wallet ever sends a MurkFun transaction, nothing is registered on chain, and the proof does not say
which holder signed.

This document is the reference for the contracts (`MurkFunOrders`, `MurkFunHolderRoots`, `MurkFunMarket`; verified
source on BscScan and Sourcify, addresses in [networks/bsc.json](../networks/bsc.json)), the order and batch circuits
and the MCP's prover ([src/orders.ts](https://github.com/murkfun/murkfun-mcp/blob/main/src/orders.ts)). The holder set's own code (tree, audit, fraud proofs,
the batch circuit and the contract's source) is public at https://github.com/murkfun/holder-roots
(the `murkfun-holders` command).

## 1. Parties

| Party | Does | Trusted for |
| --- | --- | --- |
| Wallet (Binance Agentic Wallet, or any deterministic signer holding an Agent ID) | signs the seed message once, then one message per order | nothing beyond its own funds |
| Agent (the MurkFun MCP, `murkfun-mcp`) | builds the order, computes the witness, proves it with Barretenberg `bb`, picks a random submission delay | the user's privacy (it holds the vault) |
| Relayer | pays gas, submits the order, takes the fee the order names | liveness only: it can not change an order |
| `MurkFunOrders` (the order gate, one per market) | checks the holder root, the nullifier and the proof, then calls the market | nothing: no owner, no upgrade |
| `MurkFunMarket` | runs the action (curve, balances, caps, fees, graduation) | its rules (verified source); it only accepts orders from its gate |
| `MurkFunHolderRoots` (the holder set) | keeps the Merkle tree of Agent ID holders | see §4 and §5 |
| Holder-set owner (Ownable2Step; today the same EOA as the operator, no timelock) | sets the operator (`setOperator`) and the holder-set parameters (`setParams`), both effective at once; `CHALLENGE_PERIOD` has a 10 min floor, `MIN_BOND` and `DISPUTE_DEPOSIT` have none | liveness and timing: it can not add or remove a holder |
| Holder-set operator (MurkFun's operator service) | the only address that posts batches (proven); unbonded on mainnet (`MIN_BOND` = 0) | liveness only: fraud proofs and forced inclusion bound it; a stall is fixed by the owner's `setOperator` (today the same key) |
| Anyone | challenges a bad batch, disputes an origin, forces a missing holder in (free) | |

## 2. Signatures and identifiers

Both messages are EIP-712 typed data with the domain `{ name: "MurkFun Order", version: "1", chainId: 56 }` (no
verifying contract: the circuit has the domain separator as a constant).

- **S1, the seed signature**: `MurkFunSeed { string purpose }` with
  `purpose = "MurkFun seed: only sign this on MurkFun"`. Signed once at setup and kept encrypted in the agent's vault.
  The agent signs it twice and requires both signatures to be identical (a deterministic signer). S1 alone can not
  place a MurkFun order: every order also needs S2. S1 is, however, the spending key of the user's 0xbow notes (the
  0xbow keys are derived from it, below): whoever obtains S1 can withdraw those notes. Sign the seed message only in
  the MurkFun agent; never in a website or another tool. The same goes for every MurkFun typed data: the domain has no
  verifying contract, so any site can ask for the identical signature (phishing).
- **S2, the order signature**: `OrderAuth { bytes32 orderHash }`, one per order. It shows the signer only an opaque
  hash; but see §7 for what the operator of the wallet itself can compute.

From S1 (r, s split into 128-bit limbs; Poseidon2 over BN254, domain tags `murk.secret`, `murk.pseudonym`,
`murk.nullifier`, `murk.order`):

```
secret     = H(TAG_SECRET, r_hi, r_lo, s_hi, s_lo)
pseudonym  = H(TAG_PSEUDONYM, secret, token)          one per wallet and token
nullifier  = H(TAG_NULLIFIER, secret, token, nonce)   one per order
orderHash  = H(TAG_ORDER, chainId, market, action, token, amount, minOut, to, nonce, relayer, fee, deadline, salt)
```

The pseudonym is never derived from the address, so a token's holders are pseudonyms that the proofs link neither to wallets nor
to each other (§7: the wallet operator, the RPC, MurkFun's servers by IP, and timing or amounts can still link them). The random `salt` keeps `orderHash` unlinkable to the public order. The 0xbow keys of the agent are a
separate HKDF output of S1 (`murkfun.0xbow-seed`), so the same wallet signing S1 again restores the pseudonyms and the
0xbow notes (`recover_from_wallet`).

## 3. Orders

`MurkFunOrders.Order { action, token, amount, minOut, to, nonce, relayer, fee, deadline, holderRoot, pseudonym,
nullifier }`. `relayer`, `fee` (BNB wei, taken from the pseudonym's internal balance) and `deadline` are the relay
terms of every action; `nonce` is the pseudonym's next nonce on the token (`MurkFunMarket.nonces`).

| Action (number) | `amount` | `minOut` | `to` | Entry |
| --- | --- | --- | --- | --- |
| Buy (1) | BNB from the balance | minimum tokens | | `execute` |
| BuyExactOut (2) | most BNB to spend | exact tokens | | `execute` |
| BuyDirect (3) | BNB paid in (msg.value), credited, `amount - fee` spent | minimum tokens | | `execute`, 0xbow adapter |
| BuyDirectExactOut (4) | BNB paid in, at most `amount - fee` spent | exact tokens | | `execute`, 0xbow adapter |
| Sell (5) | tokens | minimum BNB | | `execute` |
| WithdrawBnb (6) | BNB | | recipient | `execute` |
| WithdrawTokens (7) | tokens (after graduation) | most tokens sold to pay the fee | recipient | `execute` |
| Fund (8) | BNB paid in, credited | | | `execute` |
| SetDevRecipient (9) | | | new dev fee recipient | `execute` |
| Launch (10) | creator buy paid in (0 = none) | minimum tokens | dev fee recipient | `launch`, 0xbow adapter |
| LaunchExactOut (11) | creator buy paid in | exact tokens | dev fee recipient | `launch`, 0xbow adapter |

BNB paid into an order (BuyDirect*, Fund, a creator buy) comes, while the token is on its curve and the factory's
privacy-funding rule is on (`GET /v1/params`, the MCP's `status.privacyFunding`; the owner can change it through the
24 h timelock), only from an allowlisted privacy pool: MurkFun's 0xbow adapter (`MurkFunPrivacyPoolAdapter`, the 0xbow processor: the 0xbow proof
withdraws from a note and its `params.data` is `abi.encode(order)`) or MurkFun's Railgun adapter (`MurkFunRailgunAdapter`,
the adapt contract of a Railgun transaction that unshields WBNB to it: `boundParams.adaptContract` = the adapter,
`adaptParams` = keccak256(abi.encode(order)); it pays the order exactly what the unshield delivered). Railgun's public
RelayAdapt is not on the allowlist. After graduation any address may pay.

A launch is one order: `MurkFunOrders.launch(spec, order, proof)` creates the token at the address the order names
(`MurkFunFactory.predictTokenAddress`, which commits to the spec and the current terms), lists it with the order's
pseudonym as the dev and makes the creator buy in the same transaction, bounded by the platform's dev cap (30% of
supply by default; the dev may buy 0). `spec.launchSig`, by the one-time launch key the dev salt names, binds the dev
pseudonym, so nobody who sees a pending launch can take its address with their own order.

**Destinations (`to`).** The contracts refuse only the zero address and, for WithdrawBnb / WithdrawTokens /
SetDevRecipient, the market itself, WBNB and (WithdrawTokens) the order's own token (`BadRecipient`). They do not
refuse a Launch's dev fee recipient beyond the zero address, nor any other destination where the funds would be lost or
end up in a balance only MurkFun's owner can sweep: the token itself as a dev fee recipient, any other MurkFun token,
the factory, an order gate, the Dex, a locker, the Infinity hook, the 0xbow adapter, Railgun's RelayAdapt, the holder
set, a burn address. The clients do: the MCP refuses all of these before the wallet signs (`bad_recipient`) and asks
the user to confirm any other contract destination (`recipient_is_contract`, then `confirmContract: true`); MurkFun's
relayer refuses the same MurkFun destinations before it simulates an order (`bad_recipient`, RELAYER_API.md). An order
built and submitted by other means gets only the contract's checks.

**Execution.** `MurkFunOrders.execute` / `launch` check the msg.value rules of the action, that `holderRoot` is an
accepted root (`MurkFunHolderRoots.isKnownRoot`), that the nullifier is unused (then burn it), and the proof against
`publicInputs(order)`. A rejected proof reverts `InvalidProof`. Then `MurkFunMarket.execute(order, msg.sender)` checks
that the token is listed, the deadline, the nonce (`WrongNonce`), the paid value, the privacy-pool rule on the
submitter, the pause, and runs the action. The market accepts orders only from its gate (`orders`, set once by the
factory owner, re-pointable with the market's 24 h timelock under `what = "orders"`). Market and factory: a 24 h
timelock on owner changes and a separate pause guardian; the owner is not a multisig yet.

**Quotes** need no signature: the agent simulates `MurkFunMarket.execute` with `eth_call` from the gate's address.

**Replay and front-running.** An order runs once (its nullifier) and only at its nonce. Anyone may submit a signed
order; the effect is identical and the fee still goes to the relayer the order names. The relayer refuses an order
whose relayer field is not its own (`wrong_relayer`).

## 4. Holder set

`MurkFunHolderRoots` keeps an append-only Poseidon2 Merkle tree of the SPACE ID Agent ID holders on BSC that claimed
their Agent ID through the user path (`HandleRegistry.register`, signed by SPACE ID's backend). Addresses minted by
the registry owner (`adminRegister`) are not part of the set. Holders never send a transaction: the operator copies
the public `Registered` events.

- **Tree**: depth 26 = 2^16 batch slots of 2^10 leaves; batch `id` fills slot `id`, `leaf(A) = H(A)`, empty leaves 0.
  The Agent ID is soulbound, so a holder stays a holder.
- **Batches**: `postBatch(addrs, newRoot, subtreeRoot, fromBlock, toBlock, proof)` appends 1..1024 addresses, sorted
  strictly increasing. The batch proof (`circuits/batch`) shows `newRoot = append(currentRoot, addrs)` with every
  address a public input, so the root commits to exactly the published list (also emitted in `Batch`).
- **Roles**: the **owner** (OpenZeppelin `Ownable2Step`, a constructor argument; `transferOwnership` →
  `acceptOwnership`) sets the **operator** directly (`setOperator`, immediate, `OperatorTransferred`) and the adjustable
  parameters (`setParams`). **Only the operator posts batches**; there is no fallback poster. There is no timelock and
  no pause on this contract, and today the owner and the operator are the same EOA
  (`0x7EB4E00c640F56A395a678d927f8bED75b66A84C`), not a multisig.
- **Challenge window**: a batch's root is usable from its `usableFrom`, fixed when it is posted: `postedAt +
  CHALLENGE_PERIOD` (1 h on mainnet), but never before the previous live batch's `usableFrom` (roots become usable in
  order). It is not usable while an origin dispute against it or an earlier batch is unanswered (`heldFrom`), so an
  admin-minted entry disputed in time is never usable. A root stays valid until
  `ROOT_HISTORY` (64) newer batches are accepted.
- **Fraud proofs**: `challenge` (at any time, also after the window) shows a listed address holds no Agent ID: the
  contract reads `balanceOf` on the spot (a reverting read reverts the challenge), and as the Agent ID is soulbound
  it never succeeds against a holder. `disputeOrigin` (**only inside the batch's challenge window**, else
  `WindowClosed`) + `resolveOrigin` show a listed address has no SPACE ID registration signature (anyone answers
  with `defendOrigin` until the dispute's `answerBy` = opening time + `CHALLENGE_PERIOD`, fixed at opening like its
  deposit). A dispute holds its batch and every later one until answered, so an unanswered dispute only ever drops
  roots that never became usable; an admin-minted entry nobody disputed within the window stays listed. One open dispute per address and batch; an address whose registration signature was verified once
  (`defendOrigin` or `enqueue`, `provenOrigin`) can not be disputed again, and its open disputes in other batches are
  answered without the signature. A successful fraud proof drops the batch and every later one, pays the bond (0 on
  mainnet) to the challenger and restores the forced-inclusion queue entries the dropped batches consumed.
  Challenges are commit-reveal (`commit` one block before), so a copied transaction earns nothing.
- **Forced inclusion (free)**: `enqueue(addr, deadline, sig)` (anyone, no fee, with the address's registration
  signature) puts `addr` in a queue the operator's next batches must include once the entry is `QUEUE_GRACE` (1 h) old
  (a batch proven just before an enqueue landed stays valid). Each address can be enqueued at most once, ever
  (`enqueued`; a second `enqueue` reverts `AlreadyEnqueued`), so griefing by re-enqueueing holders that are already
  in the tree is bounded by the number of holders. Such an entry is simply included again (a duplicate leaf is
  harmless: same pseudonym); there is no way to strike entries. A fraud proof that drops batches puts the entries
  they consumed back in the queue: the replacement batches must include them again.
- **No on-chain interval**: the operator may post batches back to back. MurkFun's operator posts one batch per hour
  however many holders wait; queued entries go into the next hourly batch. When more overdue queue entries (older than
  `QUEUE_GRACE`) wait than fit in one batch (a spam wave), it posts batches back to back until every overdue entry is
  in, so new holders are not held up behind the wave.
- **Stall trade-off (owner decision)**: with no fallback poster, an operator that stops posting stalls new holders and
  the forced-inclusion queue alike, until it posts again or the owner sets a new operator (today the owner is the same
  key, so there is no independent remedy). It still can not add a non-holder, hide a holder from a batch it posts, or
  remove anyone.
- **Adjustable parameters** (`setParams(Config)`, owner only, validated, effective at once, event `ParamsSet` with
  every value; the constructor validates the same way):

  | Parameter (getter) | Mainnet | Rule |
  | --- | --- | --- |
  | `CHALLENGE_PERIOD` | 3600 s | `>= MIN_CHALLENGE_PERIOD` = 600 s (constant floor), `<= 2^32 - 1` |
  | `ROOT_HISTORY` | 64 | `>= 1` (constant floor), `<= MAX_BATCHES` |
  | `MIN_BOND` | 0 | any; checked by the next `postBatch` |
  | `DISPUTE_DEPOSIT` | 0 | `<= 2^96 - 1`; taken by the next `disputeOrigin` |

  In-flight rule: a posted batch keeps its `usableFrom` and an open dispute its `answerBy` and deposit, so no change
  makes a posted root usable earlier than `postedAt + MIN_CHALLENGE_PERIOD`, reopens an accepted root, cuts an open
  dispute's answer window below `MIN_CHALLENGE_PERIOD` or changes what a dispute pays out. `ROOT_HISTORY` applies to
  every root at once (at least the latest accepted root stays valid). `AGENT_NFT`, `BATCH_VERIFIER` and
  `REGISTRY_DOMAIN` are immutable.
- **Bond, deposit**: 0 on mainnet (`MIN_BOND`, the operator bond, `DISPUTE_DEPOSIT`): a fraud proof is worth sending
  without a reward (it removes the bad leaf from every usable root), and a dispute never stops posting (it only holds
  the disputed batch until the operator answers it). The contract supports a bond: per depositor, withdrawn only while no
  batch is in its window and no dispute is open; a slash takes every deposit.

Mainnet parameters are readable on chain (`CHALLENGE_PERIOD()`, `ROOT_HISTORY()`, `MIN_BOND()`, `DISPUTE_DEPOSIT()`).
The registry's known registration signers are its current `signer()`, the signers passed at deployment (read from its
`SignerChanged` events) and every signer that was current when anyone called `recordSigner`, `postBatch`,
`enqueue`, `disputeOrigin` or `defendOrigin`. MurkFun's operator records the current signer every round. If a
`SignerChanged` ever replaced a signer nobody recorded, the holders it registered could not be defended, and a new
HolderRoots listing it at deployment (an `orders` re-point) would be needed.

**Checking it yourself.** MurkFun's operator posts the batches; the audit (`murkfun-holders audit`, from
https://github.com/murkfun/holder-roots, anyone can run it) diffs the tree with the registry. Both read every log range
from two or more RPC endpoints and refuse on any disagreement. `murkfun-holders tree` rebuilds the tree from the
`Batch` events and compares its roots with the contract's; `murkfun-holders challenge` / `enqueue` send the fraud
proofs and forced inclusions (dry run first). The live set: https://murk.fun/holders.

## 5. Trust assumption

SPACE ID signs `register` only for Binance Agentic Wallets, whose signer is deterministic: one seed signature per
wallet, so one secret, one pseudonym per token and the per-pseudonym holding cap per wallet. A holder that controls
its raw private key could sign the seed message with other valid nonces and so hold several pseudonyms of one token
(a property of the signature scheme, not of MurkFun's code). The 1% curve-phase holding cap is per pseudonym under this
assumption. The holder set itself can not keep an address without an Agent ID (`challenge`, any time) or an
admin-minted one disputed inside its batch's window (`disputeOrigin`), hide a holder from a batch the operator posts
(forced inclusion) or add anything outside the published list (the batch proof); an operator that stops posting
delays new holders until the owner replaces it, and today the owner is the same key (§4).

## 6. Order proof

The order circuit (Noir 1.0.0, UltraHonk with Barretenberg 6.0.0; the deployed Solidity verifiers are generated with
`bb write_solidity_verifier --optimized`). Public inputs, in this order: `holder_root, chain_id,
market, action, token, amount, min_out, to, nonce, relayer, fee, deadline, pseudonym, order_nullifier` (14 field
elements; `MurkFunOrders.publicInputs` builds the same array). The circuit checks:

1. S1 over the seed digest and S2 over `OrderAuth(orderHash)` verify under the same secp256k1 key, both low-s;
2. `orderHash` is the hash of the public order fields and the private salt;
3. `leaf(address(key))` is in the tree with root `holder_root`;
4. `pseudonym` and `order_nullifier` are derived from S1 as in §2.

The MCP ships the compiled circuit and its verification key ([circuits/order.json](../circuits/order.json),
`order.vk`); noir_js computes
the witness and `bb` proves it (`MURKFUN_BB`, a `bb` 6.0.0 on the PATH, used as is, or downloaded once from Aztec's
GitHub release into `~/.murkfun/bin`; only the download is checked against a pinned sha256). The witness exists only in memory and in a private temp
directory removed after proving. A proof takes a few seconds on a laptop.

A changed circuit means a new verifier and so a new `MurkFunOrders` (re-pointed with the market's 24 h timelock, so
visible on chain a day in advance). The MCP refuses an order gate whose verifier's code hash is not the one in its network file.

## 7. Privacy

- On chain: the order fields, the pseudonym, the nullifier and the holder root. Not the wallet, not which leaf.
- **The wallet's operator can link everything to the wallet.** S1 is a deterministic signature by the wallet's key,
  and the pseudonyms and 0xbow keys are pure functions of S1. For the Binance Agentic Wallet, Binance holds that key
  (the wallet has no exportable key; it signs on Binance's side), so Binance can compute S1 for any wallet without the
  user doing anything, and from it every pseudonym of that wallet on every token and its 0xbow notes: all of a user's
  MurkFun activity links to the Binance account behind the wallet. This is permanent and by design: one deterministic
  pseudonym per wallet and token is what lets the contract enforce the 1% holding cap per user, and a user-held
  secret that hid it from the operator would give up that cap. The proofs hide the wallet from other users and chain
  observers; not from the wallet operator. By default the MCP asks MurkFun's holder API for your wallet's path from
  your IP, and MurkFun also runs the relayer, so MurkFun can link wallet and pseudonyms by IP unless you set
  `MURKFUN_HOLDERS_API=` (empty) and use Tor or a VPN.
- The signer also sees when each order was signed; the agent submits each order after a random delay
  (`MURKFUN_ORDER_DELAY_MS`, 30 s to 3 min by default), which makes timing correlation by chain observers harder; it
  does not hide the timing from the wallet operator (who can compute the pseudonyms anyway).
- The relayer sees the order and the IP address it came from, so it can link the orders sent from one IP address
  (several pseudonyms of one user included). Use a VPN or Tor for the agent's traffic if that matters; the relayer's
  hosting provider may log IP addresses too.
- The model provider of the AI agent sees the tool results: the wallet address and the pseudonyms appear in them
  together.
- The RPC the agent uses sees the wallet's and the pseudonyms' balance reads together; use your own RPC if that matters.
- While the factory's privacy-funding rule is on, BNB on the curve comes only from privacy pools; while it is off (as on
  production since 2026-11-09, pending the timelock) and after graduation a plain wallet may fund a pseudonym (its address is public). Withdrawals to a public address are public (by default the MCP allows only the
  user's own wallet, which links the pseudonym to it).

## 8. Gas and sizes (BSC fork measurements)

| | Gas |
| --- | --- |
| order proof verification | ~748,000 |
| buy order through the gate (transaction) | ~1,330,000 |
| `postBatch` of 1,024 addresses (transaction) | ~2,200,000 (~2,150 per address) |
| `challenge` (transaction) | ~475,000 |

Runtime sizes: `MurkFunMarket` ~20.3 KB, `MurkFunOrders` ~4.3 KB, `MurkFunHolderRoots` ~13.7 KB, the two verifiers
~17 KB each (all under EIP-170's 24 KB).
