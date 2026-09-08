# Blockathon Red Cross

## Problem and source

The primary project source is the Swedish Red Cross problem statement, **“Secure Crisis Communication — Misinformation, Trusted Information & Verifiable AI.”** The team currently has a supplied summary; the original PDF is not in this repository and has not been reviewed for this setup.

The problem concerns secure, scalable communication for humanitarian volunteers and crisis response, and recipient verification of information claimed to come from the Swedish Red Cross. Suggested exploration includes tamper-resistant registries, cryptographically signed official communication, on-chain provenance, and recipient-verifiable authenticity. These are possible directions, not agreed features. Beneficiary identity, biometrics, and aid payments are outside this case.

## Current state and team workflow

The original five-scenario **presentation at `/` is unchanged and simulated**. The **MVP at `/publish` and `/inbox`** uses real EIP-712 signatures, a Node/TypeScript API, SQLite and CrisisRegistry. It has two explicit runtime profiles: persistent local Anvil and Ethereum Sepolia L1. **Both profiles use the same frontend, backend, verifier, signing format and contract source.** Alex publishes; Kim receives and verifies automatically in an independent browser session. The shared live views use English copy and a responsive, phone-width layout (up to 440 px), including on desktop for demonstrations. Network metadata stays in the optional verification details. Existing signed message bodies are never translated; new drafts use English example text. All examples use fictional scenarios and an explicit Demoorganisation, not official Swedish Red Cross credentials. There is no CI workflow. Sepolia requires the operator's configuration and explicit deployment; no public deployment address is supplied or assumed by the repository.

The following are team working rules, not requirements attributed to the problem statement: ChatGPT supports Mats with product decisions and task contracts; Codex implements bounded assignments and delivers through GitHub. See [AGENTS.md](AGENTS.md). Priorities are low recipient friction, a reproducible demo, and explicit trust assumptions.

## Selected MVP decisions

The implementation assignments selected the existing React/TypeScript/Vite frontend, a small Node API, SQLite, viem, OpenZeppelin EIP712/ECDSA and Foundry (Anvil/Forge). The immutable contract fixes one explicitly configured publisher EOA, organisation, feed and series at deployment. Local initialization generates a test publisher; Sepolia uses the operator's chosen public publisher address. Transport is a loopback HTTP API with automatic polling. These are MVP choices, not requirements attributed to the original problem statement. Real organisational onboarding, production networks, administration, revocation, offline distribution and Sullis/submission remain outside this implementation.

## Run locally

For the presentation alone, use Node.js 22.21+ (or a compatible newer version) and npm:

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5175. The server uses a strict port and binds only to loopback. After installation, the presentation needs no internet connection or external runtime resources. The real application needs the additional services described below.

## Start the real MVP

Prerequisites: Node.js 22.21+ with `node:sqlite`, npm, and [Foundry](https://getfoundry.sh/) (`anvil` and `forge`). Tested locally with Node 22.21.1 and Foundry 1.5.1. SQLite is experimental in this Node version and prints a startup warning. First installation/compilation needs network access for packages and Solidity 0.8.30; subsequent runtime is local.

First initialization, from this checkout:

```sh
npm ci
npm run local:init
npm run local:start
```

`local:init` compiles the contract, generates a new publisher test key, funds it with local test ETH, deploys using a separate ephemeral deployer, writes public trust configuration and creates an empty SQLite database. The deployment key is discarded. Anvil has **zero unlocked development accounts**. No application endpoint signs or sends publishing transactions. The generated publisher key is stored only in ignored `.local/publisher.key` (mode 0600 inside a 0700 directory), never in a `VITE_` variable or the client bundle.

Normal subsequent start is **`npm run local:start`**, which loads existing chain state and the existing database. It fails if deployment/chain state is absent or inconsistent, or the database file is missing; it does not redeploy or create an empty replacement database. Stop with Ctrl+C so Anvil saves its history. State is also saved every second; an abrupt process/OS failure can lose the latest unsaved chain state, which requires investigation rather than silently trusting database rows. The SQLite API can restart independently without losing messages.

Foundry 1.5 snapshots can retain extra genesis headers from earlier starts. The local loader resolves the original header by the already trusted genesis hash in a temporary read-only probe, then loads all saved records with that header last and its original timestamp. This fixes ambiguous block-0 lookups without deleting history or changing deployment configuration. Full chain/contract checks still run before the API starts.

| View/service | Local address |
| --- | --- |
| Existing simulated presentation | http://127.0.0.1:5175/ |
| Alex, real publication | http://127.0.0.1:5175/publish |
| Kim, automatic recipient verification | http://127.0.0.1:5175/inbox |
| Node/SQLite API | http://127.0.0.1:3001/api/health |
| Anvil RPC | http://127.0.0.1:8545 |

All listeners bind to `127.0.0.1`. Use that hostname consistently. To reuse an already running frontend from this checkout, use `npm run local:services` for just Anvil/API. Alternatively run `npm run local:chain`, `npm run local:api` and `npm run dev` in three terminals. Restart API by stopping/restarting only `local:api`; do not run duplicate servers. Stop and restart an older Vite process once if it was started before `vite.config.ts` existed.

## Separate Sepolia profile

| Profile | Frontend | API | Chain / storage |
| --- | --- | --- | --- |
| `local` | http://127.0.0.1:5175/publish · http://127.0.0.1:5175/inbox | http://127.0.0.1:3001/api/health | Anvil 31337 · `.local/` |
| `sepolia` | http://127.0.0.1:5176/publish · http://127.0.0.1:5176/inbox | http://127.0.0.1:3002/api/health | Ethereum Sepolia L1 11155111 · `.sepolia/` |

Both profiles use the same frontend, API, verifier, EIP-712 format and CrisisRegistry source. Only network/deployment settings, storage and timing differ. The presentation remains at http://127.0.0.1:5175/. All services bind to loopback; no web hosting is involved. Port conflicts never stop another process.

### Deploy with MetaMask

Use a dedicated test account in your browser wallet. **No private-key export, Cast keystore, seed or password is needed by this app.** The same EOA can be both deployer and publisher. Foundry compiles the unchanged contract; the browser wallet signs and sends the deployment.

1. Create the ignored settings file (do not overwrite an existing one):

   ```sh
   mkdir -p .sepolia
   chmod 700 .sepolia
   cp -n config/sepolia.example.json .sepolia/settings.json
   ```

2. Edit these public fields:
   - `chainId`: `11155111` only.
   - `rpcUrl`: an HTTPS RPC explicitly suitable for public browser access. No credentials, secret tokens (including URL paths), query strings or fragments. It must serve the genesis block, deployment history and verifier methods; a working chain-ID call alone is insufficient. There is no RPC proxy or automatic fallback.
   - `rpcVisibility`: `"public-browser"`.
   - `publisher`: the public MetaMask account authorized to publish this series.
   - `deployer`: the public MetaMask account sending deployment; it may equal `publisher`.

3. Ensure the selected account(s) have **Sepolia test ETH**. The application does not buy, bridge or fund accounts.
4. Check the build, chain/genesis, publisher/deployer EOAs, RPC methods, actual browser CORS, estimated cost and available balance:

   ```sh
   npx playwright install chromium
   npm run sepolia:check
   ```

5. Start setup and open http://127.0.0.1:5176/deploy in the browser with MetaMask:

   ```sh
   npm run sepolia:deploy
   ```

6. Select Ethereum Sepolia and the exact configured deployer yourself. Choose **Kontrollera MetaMask**, inspect publisher/deployer and the estimated maximum cost, then **Deploya på Sepolia** and approve the transaction in MetaMask. Starting the command or opening the page never sends a transaction.
7. After **Deployment verifierad och sparad**, stop this Sepolia process with Ctrl+C and start the normal shared app:

   ```sh
   npm run sepolia:start
   ```

   Open http://127.0.0.1:5176/publish and http://127.0.0.1:5176/inbox in independent sessions. The existing Anvil process can remain running throughout.

If deployment is absent, `sepolia:start` also enters setup mode and redirects `/publish` and `/inbox` to `/deploy`. Missing settings produce an explicit configuration error there. Invalid existing deployment files fail startup; they never trigger replacement or Anvil fallback. Once normal application mode is running, `/deploy` is unavailable.

The browser sends exact compiled bytecode plus the unchanged constructor context through EIP-1193. The setup-only API on 127.0.0.1:3002 requires the local app's origin for writes and accepts no arbitrary config/file paths. It never signs or broadcasts. Browser and server independently require a successful included receipt, matching sender/nonce/constructor/address, compiled runtime code and immutable context, Sepolia genesis, deployment block/hash and a stable control block. Only then can the server create `.sepolia/demo.sqlite` and write `.sepolia/deployment.json`. Confirmation is idempotent and cannot replace a deployment.

A durable `.sepolia/pending-deployment.json` is written **before** the browser may call the wallet. Concurrent tabs cannot begin another attempt. After the wallet returns a hash it is also saved in browser storage and the journal. A timeout/429 leaves the attempt intact: use **Fortsätt kontrollera deploymenten** after reload/restart; this only reads/validates and never sends another transaction. If the send result is unknown without a hash, inspect MetaMask's activity and enter the actual public deployment transaction hash. Never delete the journal to retry an uncertain broadcast. A rejected/aborted dialog conservatively retains the intent too; if no transaction was sent, an operator must establish that fact before deliberately removing that attempt. There is no automatic reset or nonce change. Legacy Cast journals are not silently migrated, reused or deleted.

Normal startup never deploys, funds, creates a missing application database or resets data. A later contract-source change requires a separate explicit deployment decision. `npm run build` checks TypeScript and builds the common application into `dist/local` and `dist/sepolia`; runtime settings, journals and keys are not bundled. Low-level Vite modes remain `app-local` and `app-sepolia`.

Vite serves a strictly validated public `/deployment.json` for its selected profile only. Both devservers deny file access to `.local`, `.local-backups`, `.sepolia`, `.git` and secret file types. `.env` files are not loaded by Vite. Deployment config stays outside SQLite and includes the RPC, EIP-712 domain, publisher/context, genesis, deployment block/hash, code hash and Sepolia deployment transaction hash. Do not add secrets or `VITE_` key material.

The Sepolia wallet must select **chain ID 11155111** and the exact configured `publisher`. The app rechecks account/network immediately before both signature and transaction; it never selects Anvil's account or switches profiles based on the wallet. Kim only needs the configured browser RPC. Sepolia contract/confirmed transaction explorer links are inside **Verification details**. Native extension permission/signature/transaction dialogs remain a manual check: open 5176 `/publish` with that wallet, publish version 1 and an update, and observe 5176 `/inbox` in a separate session without a wallet. Test providers are not evidence that these extension dialogs work.

Both profiles require **one successful included transaction plus a matching registry/event/receipt**: this is chain confirmation, **not finality**. Public-network reorganizations remain possible and each subsequent check revalidates block-bound evidence. Sepolia polls 15 seconds after the preceding check completes (local: 2.5 seconds), with at most four concurrent packet checks and no automatic RPC retries. Sepolia RPC request starts are spaced by at least 350 ms per endpoint in each tab/server process, with a bounded queue; separate browser tabs still share the public provider limit. Failed RPC checks identify the unavailable step (including rate limits) without exposing raw provider errors. RPC timeout is 12 seconds and receipt wait is bounded at 45 seconds. A timeout/429/delayed receipt is an unknown outcome, not a failed transaction. A signed saved attempt is reconciled on load and on **Continue checking** without requesting wallet access. If its exact package is already published, the client verifies the registry/event/receipt/context, completes SQLite storage/confirmation idempotently, refreshes head and tombstones only that completed attempt. The composer then offers the next version. Unavailable evidence or an unknown send result keeps the attempt and disables editing/discard. The frozen package and transaction hash survive in the pending attempt. **Continue publishing** remains available for a signed package whose transaction was definitely not requested; unknown send outcomes only allow another check.

Browser cache/attempt keys bind chain ID, genesis, contract, deployment block hash and code hash. Existing local entries are read compatibly and reverified; no local data is deleted or migrated destructively. A packet copied between profiles is rejected even with the same publisher/text. Only `.local` supports the intentional coordinated reset below. Do not use a local reset to repair Sepolia, delete its deployment journal after an ambiguous send or replace trust configuration with database values. Future contract-source changes require a later, explicitly planned **new deployment**; normal app development/start/build cannot trigger it.

### Connect Alex's browser wallet

Use a separate browser-wallet account/profile dedicated to this local demo. Open `.local/publisher.key` locally and import that generated test account into a regular EIP-1193 browser wallet. Do not copy the key into source, messages, command arguments, screenshots or issue reports. The public address is printed by initialization and appears under **Verification details** in the app.

Add/select the local network with RPC `http://127.0.0.1:8545`, chain ID **31337**, currency **ETH**, and no block explorer. Open `/publish` in that wallet-enabled browser. Enter the message, choose **Review message**, inspect the exact frozen text, then **Sign and publish**. Approve both the typed signature and the local transaction. Switching account/network or cancelling a dialog cannot complete publication. Editing discards the frozen package and requires a new signature. After success, edit the text and review again to publish the next version.

Kim opens `/inbox` in a different browser/profile or private context. No account, wallet, login or verification button is needed. The client polls about every 2.5 seconds after the previous check completes. Older text remains visible as superseded. **Continue publishing** retries the same signed package after a cancellation or interrupted API/confirmation step; it survives page reload. Do not discard a sent transaction: retry to resolve its outcome. The next version is never created as an automatic retry.

Browser automation uses a **test-only EIP-1193 device**, installed exclusively by `tests/browser.test.ts`, with real signing/raw transactions performed by a temporary test account in the test process. It never passes a private key into the page and is not imported by the app. The native extension's permission, signature and transaction dialogs have **not** been exercised in this environment. The remaining manual check is to import the generated local testwallet, select chain 31337 and approve those two dialogs in `/publish`, with `/inbox` open in another session.

## Signed format, authority and persistence

`shared/protocol.ts` strictly validates the common envelope. `bodyHash` is keccak256 over the exact UTF-8 text, with no trimming or Unicode normalization. Unpaired surrogate code units are rejected. The typed `Message` binds `bodyHash`, `sender`, `organisation`, `feed`, `messageId`, `version` (`uint32`) and `previousDigest`. Its EIP-712 domain is `CrisisMessage`, version `1`, the selected chain ID (31337 or 11155111) and the deployed verifying contract. **`packageDigest` hashes the complete typed package; it is different from `bodyHash`.** [viem typed signing](https://viem.sh/docs/actions/wallet/signTypedData) and [OpenZeppelin EIP712/ECDSA](https://docs.openzeppelin.com/contracts/5.x/api/utils/cryptography) supply the cryptography; JSON is only a storage/transport encoding.

`contracts/CrisisRegistry.sol` is non-upgradeable. Only the fixed EOA may send a publication transaction, and its EIP-712 signature must match. The constructor pins the organisation, feed and series ID; a new arbitrary ID cannot restart the sequence. Version 1 requires the zero predecessor, then every update must advance the head by exactly one and name its current digest. Records remain addressable by version. The contract receives only typed hashes and synthetic identifiers, never the message body, including in calldata/events.

Publication progresses through signing, SQLite storage, wallet transaction and mined confirmation. Storage validates signatures and refuses overwriting existing packet bytes. Confirmation requires a successful mined receipt, matching publisher, exact CrisisRegistry event inside the successful receipt, canonical publication block and version record. A wallet may route its outer transaction through an EIP-7702 delegation manager: the event-emitting registry must match the trusted contract even when the receipt's outer `to` differs. The router is not an authority or a new trust root. A returned transaction hash alone is insufficient. Repeated requests for the exact same packet are idempotent. A chain-confirmed packet can be recovered if the final API acknowledgment was interrupted; even without a database transaction reference, Kim locates evidence directly through the contract's event/record.

Local files are separated by authority:

- `.local/deployment.json`: trusted public configuration outside the database. Vite serves just this file at `/deployment.json`; packets cannot supply RPC addresses, contract addresses or replacement publisher keys. The client checks chain ID, genesis/deployment block hashes, contract runtime-code hash and immutable context. A mismatch fails closed.
- `.local/demo.sqlite`: untrusted exact text, signed envelope and delivery references. API validation is not a recipient approval. A writer with direct SQLite access can still alter/remove rows; the recipient verifies them again.
- `.local/chain.json`: persistent Anvil history, including old records, events and receipts. Normal startup loads it. The trusted RPC is an explicit MVP assumption; no light client is implemented. Anvil's local debugging interface is trusted infrastructure and must not be exposed to other machines.
- Browser local storage: previously verified packet copies and Alex's incomplete publication attempt. Stored content is rechecked after reload; stored approval flags are not used. Cache keys include the deployment identity. If storage is unavailable the same-session copies remain, but browser-restart recovery is unavailable.

The threat model grants an attacker database write access, but not the publisher key, client verification code, local deployment configuration or trusted RPC. Authenticity, content integrity, authority and current status are separate; a valid signature does not make the message factually true. Related contract reads use one captured block, checked again before accepting the result. Each check is bound to actual received bytes and a request generation. Late responses cannot approve changed content. Invalid arrivals never replace a verified copy. Duplicate deliveries cannot displace saved history. The MVP accepts at most 1,000 packets per fetch and retains up to 1,000 distinct saved packets; it is intentionally a small local series.

Pending, passed, failed and unavailable are distinct. A valid signature with no publication record is pending. A demonstrated mismatch fails. Missing evidence or RPC failure cannot produce green status. The UI separately shows signature verification and current/superseded status, plus the latest successful status-check time. Prior checks are historical during a failed new check. The chain head is read even for an empty or failed API response. When current content is absent, the UI says so; a saved copy is labelled, and an older version never remains current. A hash cannot reconstruct missing text.

## Reproduce database manipulation

Publish version 1 containing **14.00** through Alex's wallet first. These CLI commands target **only `.local/demo.sqlite`** with a synthetic-database marker and reject symlink paths. They do not change deployment configuration, chain state or signatures. Snapshot/restore touches message rows only; the backup is `.local/demo-snapshot.json`. There are no attack endpoints or attack controls in the real UI.

1. Save recoverable rows, change the text without signing, and observe Kim reject the actual fetched 16.00 package. A previously verified 14.00 copy remains separate:

   ```sh
   npm run demo -- snapshot
   npm run demo -- tamper-text
   npm run demo -- restore
   ```

2. Use `/publish` to legitimately publish version 2. Snapshot both versions, then make the database serve only correctly signed version 1:

   ```sh
   npm run demo -- snapshot
   npm run demo -- serve-v1
   ```

   Kim discovers head version 2 directly from the chain and labels version 1 superseded. A fresh browser session has no version-2 text and explicitly reports it missing. Restore rows with `npm run demo -- restore`.

3. With a saved snapshot, remove the contents:

   ```sh
   npm run demo -- delete-content
   ```

   A fresh session shows missing content, never reconstructed text. An existing session may still show its independently checked saved copy, alongside the missing-delivery notice. Finish with `npm run demo -- restore`.

### Deliberate coordinated local reset

Stop all three services first, including Vite on 5175, then run:

```sh
npm run contract:build
npm run local:reset -- --confirm-local-reset
npm run local:start
```

This archives the entire old `.local` directory under ignored `.local-backups/<timestamp>` and initializes a **new** wallet, chain, contract, database and trust configuration together. Reload clients and import the new local wallet; the new deployment uses new browser-storage keys. Do not delete only the database, chain state or deployment configuration as a reset. The archive contains the old test key and remains local. A failed first initialization is not a working deployment; inspect it or use this explicit reset instead of manual partial deletion.

## MVP checks

```sh
npm test
npm run test:mvp
npm run build
npx playwright install chromium
npm run test:browser
npm run test:profiles
npm run test:deployment
npm run test:recovery
git diff --check
```

The existing 50 presentation/model tests are preserved. The MVP suite starts a separate temporary Anvil/SQLite/API environment and checks typed-digest parity, exact Unicode/text, metadata/domain/signature changes, unauthorized senders, fixed series, replay, concurrent predecessors, pending storage, cancellation, failed storage, reverted mined receipts, immutable/idempotent writes, direct database tampering/rollback/deletion, false reference confirmation, cache duplicates, late callbacks, missing evidence, RPC failure, and both backend and chain restart. Browser tests use separate publisher/recipient contexts, exercise real signatures and local transactions, automatic updates, reload/restart, all three database demonstrations, RPC interruption and the original presentation. Fixtures and browser surfaces are closed afterward. Screenshots are ignored under `output/playwright/`.

`test:profiles` runs both profiles together using temporary Anvil instances, SQLite/API servers and browser origins. Its **test-only** Sepolia RPC facade emulates Sepolia's chain ID, genesis and HTTPS destination over loopback; this is not a public Sepolia deployment or CORS result. It covers cross-profile rejection, routing/cache/attempt isolation, pending receipt/429 recovery without duplicate publication, deployment receipt validation, bytecode checks, immutable context, changed control blocks, database tampering/rollback/deletion and unavailable evidence. A separate real browser/HTTP fixture checks that server RPC success with blocked CORS fails. Normal automated tests never call a public RPC, faucet or testnet. Only explicit Sepolia commands and the Sepolia browser views exercise the configured public endpoint.

`test:deployment` runs the actual setup API and `/deploy` view with a test-only EIP-1193 provider backed by generated accounts and real local EVM transactions. It covers wrong account/network, missing wallet, foreign-origin writes, pending/429, restart/resume and lost send responses without duplicate deployment, altered constructor/context/genesis, idempotent confirmation, and subsequent shared publish/inbox in independent browser sessions. Private keys stay in the test process. This does **not** verify MetaMask extension dialogs or public Sepolia deployment.

`test:recovery` adds a real local EIP-7702 routed publication, a lost confirmation followed by reload with all wallet access forbidden, version-2 composer recovery, exact receipt-log negative cases, and non-discardable unknown send outcomes. The contracts in `test/RecoveryWallet.sol` are test fixtures only; application deployment still uses the unchanged CrisisRegistry.

## Original presentation: present and reset

The Swedish scenario buttons prepare a starting state. **Publicera** drives direct delivery and automatic checking; the recipient needs no verification button:

- **Publicering:** edit the message if desired, then publish. Kim receives the complete package through the preset subscription to Övning Norr.
- **Vidarebefordran:** starts with an official original already received by Kim. Forward the copy unchanged or edit any text first. The received copy has its own result and cannot overwrite the official original. Editing after sending only changes the next copy; the sent snapshot finishes its check unchanged.
- **Uppdatering:** starts with received version 1. Publish the prepared 16.00 update; it is delivered automatically. After checking, version 2 is current and version 1 is replaced, with its original text retained.
- **Utan uppkoppling:** starts with a message checked at fictional time 13.50. Select **Koppla från volontären**, then publish an update. Kim receives no new content or status during the interruption. **Återanslut volontären** automatically retrieves missed official packages and fresh status, then checks them.
- **Databasmanipulation:** starts after an assumed compromise of message storage, with the original already checked by Kim. Edit **Lagrad meddelandetext**, select **Spara databasändring**, then **Simulera ny hämtning** to represent the next read from the message service. An unchanged fetch passes; altered content is rejected separately from the local original. **Ta bort posten** followed by a new fetch gives a retrieval error. The read-only publication evidence remains separate and unchanged. Reset restores the row and all reception/check state.

**Återställ** restores the selected scenario, including text, connection and evidence. Reloading returns to **Publicering**. Nothing persists. **Så fungerar verifieringen** opens a proposed-architecture explanation and a package example using current model values; it starts collapsed and expands in the normal page flow. Delivery, signing and chain checks are all local simulations, with no real hashes or signatures.

Use Tab and Enter/Space for controls and the disclosure, and standard keyboard editing in text fields. Reduced-motion preferences disable transitions. At 1280×800 or larger the phones fit side by side; smaller screens stack them. Scroll the page to read the expanded technical explanation; long messages or extended reception history can scroll within a phone.

## Original presentation: model and checks

`src/model.ts` owns immutable published packets, the explicit sender/context allowlist, field comparisons, replacement references and independent integrity/authority/status results. `src/simulation.ts` separates the publisher registry, recipient-local evidence, queued deliveries, immutable received snapshots and editable copies. Reception IDs are independent of message IDs and references. Generation and revision tokens reject obsolete delivery/check callbacks after reset, scenario changes, disconnects or newer reception batches; editing a copy leaves existing callbacks and received packets intact. The storage map is untrusted and independent of publication evidence: its own verified flag travels with the response but never controls verification. Each fetch snapshots the actual stored package or a missing-row response. Reconnection also reads content from storage; the trusted registry never reconstructs a deleted message. Scenario names never determine verification results. All status data is synthetic; the offline control simulates loss of the recipient's status connection, not an offline delivery platform. The demo allowlist is the trust root, not real Swedish Red Cross authorization.

```sh
npm test
npm run build
git diff --check
```

The focused presentation model tests cover all five scenarios, storage tampering/deletion with and without cache, frozen fetch responses and control results, direct delivery, official updates, arbitrary content/metadata changes, unknown evidence, unauthorized senders/keys, subscription context, stale status, offline catch-up, Unicode differences, editing during receipt checks, reset and obsolete callbacks. These remain simulation tests, separate from the real MVP integration tests above.
