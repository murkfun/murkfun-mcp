# Recovery drills: backup → wipe → restore

What a user does when their machine (or just `~/.murkfun`) is lost, step by step. The steps work against mainnet
([Doing it on a real machine](#doing-it-on-a-real-machine)); the amounts are examples.

> **The recovery file holds your plaintext wallet key.** Anyone who reads it controls your MurkFun funds and can link
> all your pseudonyms. Keep it encrypted or offline (a USB stick in a drawer, paper, a password manager): never in a
> synced folder (Dropbox, iCloud, Google Drive, OneDrive), never in email or chat, never pasted into the agent
> conversation. `export_recovery` writes it only inside `MURKFUN_HOME` or `MURKFUN_EXPORT_DIR` (a directory you set,
> e.g. the USB stick); move it off the computer and delete the local copy.

## Drill 1: wipe → recover from the wallet (no backup at all)

Setup: a user with their own wallet (`setup {walletKeyFile}`; with the Binance Agentic Wallet, `setup {signer:"baw"}`)
holding a SPACE ID Agent ID and in an accepted batch of the holder set, the vault at the default
`~/.murkfun/vault.json`.

1. **Normal use.** `deposit 0.05`, `deposit 0.03`; once the ASP approves, three 0xbow buys of 0.017, 0.0123 and
   0.02 BNB (the first two from the 0.03 note and its change, the third from the 0.05 note), then `sell 40%`. Note what
   `status` shows.
2. **Lose everything.** Stop the MCP server and `rm -rf ~/.murkfun`: no encrypted copy, no recovery file.
3. **Recover.** `recover_from_wallet {walletKeyFile}` (or `{signer:"baw"}`): the same wallet signs the same seed message,
   which gives the same secret. The wallet is still in the holder set (soulbound, append-only); both deposits are
   found from the pool's `Deposited` events, each change note from the `PrivacyPoolFunded` amounts of this secret's
   pseudonyms, and the position from the per-token pseudonyms.
4. **Check.** `status` equals the status from step 1 (wallet, position, unspent notes 0.03 and 0.0007 BNB), and a new
   buy from the recovered note and a sell are mined.

The Binance Agentic Wallet has no key to back up: its account is the backup.

## Drill 2: back up → wipe → restore (a wallet the MCP created)

Setup: a new user whose wallet the MCP created (`setup {}`), holding a SPACE ID Agent ID and in an accepted batch, the
vault at the default `~/.murkfun/vault.json`, and an "offline" directory for the backups (`MURKFUN_EXPORT_DIR`).

1. **Normal use.** `deposit 0.06`; once the ASP approves, `buy` from a 0xbow note, `sell 30%`. `status` shows one
   position with tokens and BNB.
2. **Back up**, as the guide says: `backup {path}` (an encrypted copy of the vault; useless without the passphrase) and
   `export_recovery {path, confirm:true}` (the plaintext wallet key, the deposit list and the token list), both into
   the offline directory. Keep the passphrase separately.
3. **A: wipe → restore the encrypted backup.** Stop the MCP server, `rm -rf ~/.murkfun`, start it again. `status` now
   fails with `no vault yet`. `restore {path}` → `status` equals the status from step 1 (wallet, positions, notes), and
   a `sell 50%` is mined: the restored position is usable.
4. **B: wipe → restore from the recovery file.** `rm -rf ~/.murkfun`, restart, `setup {recoveryFile}` (same wallet),
   `recover` → `positionsFound: [token]`; `status` shows the same positions and unspent notes as before the wipe, and a
   new `buy` from the recovered 0xbow note is mined.
5. **C: an older recovery file without the token list** (a file exported before the first trade). After wipe +
   `setup {recoveryFile}`, `status` lists no positions; `recover` then finds them on chain (it derives this wallet's
   pseudonym for every MurkFun token and checks the balances). After a restart the positions are still there.

## What a restore brings back

- The 0xbow notes: `recover` rebuilds them from the seed signature and the chain. It scans from the current MurkFun
  deployment's block; a deposit made before it needs `recover {deposits: [{index, valueBnb}]}`.
- The positions: `export_recovery` writes the token list and `setup {recoveryFile}` imports it; `recover` also finds
  the positions on chain (`positionsFound`), which works with any recovery file.

## Doing it on a real machine

The same steps work against mainnet. Do the wipe only after checking that both backup files are off the machine and
the passphrase is known. To avoid touching the real vault, run a second MCP config with `MURKFUN_HOME=<empty dir>` for
the restore and compare its `status` with the original before deleting anything. Never paste the recovery file or the
passphrase into the agent conversation.
