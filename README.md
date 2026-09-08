# Blockathon Red Cross

## Problem and source

The primary project source is the Swedish Red Cross problem statement, **“Secure Crisis Communication — Misinformation, Trusted Information & Verifiable AI.”** The team currently has a supplied summary; the original PDF is not in this repository and has not been reviewed for this setup.

The problem concerns secure, scalable communication for humanitarian volunteers and crisis response, and recipient verification of information claimed to come from the Swedish Red Cross. Suggested exploration includes tamper-resistant registries, cryptographically signed official communication, on-chain provenance, and recipient-verifiable authenticity. These are possible directions, not agreed features. Beneficiary identity, biometrics, and aid payments are outside this case.

## Current state and team workflow

The repository now contains a local interactive concept prototype for team discussion: two simultaneous views show an authorized coordinator and a subscribed volunteer receiving automatically checked messages; the forwarding scenario adds an editable copy as an alternative transport path, while the database scenario adds a technical storage panel between the two phones. All roles and scenarios are fictional. Signing and chain checks are simulated, without cryptography, backend, external integrations or official organizational verification. There is no CI workflow.

The following are team working rules, not requirements attributed to the problem statement: ChatGPT supports Mats with product decisions and task contracts; Codex implements bounded assignments and delivers through GitHub. See [AGENTS.md](AGENTS.md). Priorities are low recipient friction, a reproducible demo, and explicit trust assumptions.

## Open decisions

Chain, stack, communication channel, internal versus public distribution, and wallet model remain undecided. Demo identities must not imply real organizational verification. Sullis/submission is handled separately; import support and competition requirements are unconfirmed.

## Run locally

Use Node.js 22.12+ (or a compatible newer version) and npm:

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5175. The server uses a strict port and binds only to loopback. After installation, the presentation needs no internet connection or external runtime resources. Vite, React, TypeScript and plain CSS are prototype choices, not a decision about the future product architecture.

## Present and reset

The Swedish scenario buttons prepare a starting state. **Publicera** drives direct delivery and automatic checking; the recipient needs no verification button:

- **Publicering:** edit the message if desired, then publish. Kim receives the complete package through the preset subscription to Övning Norr.
- **Vidarebefordran:** starts with an official original already received by Kim. Forward the copy unchanged or edit any text first. The received copy has its own result and cannot overwrite the official original. Editing after sending only changes the next copy; the sent snapshot finishes its check unchanged.
- **Uppdatering:** starts with received version 1. Publish the prepared 16.00 update; it is delivered automatically. After checking, version 2 is current and version 1 is replaced, with its original text retained.
- **Utan uppkoppling:** starts with a message checked at fictional time 13.50. Select **Koppla från volontären**, then publish an update. Kim receives no new content or status during the interruption. **Återanslut volontären** automatically retrieves missed official packages and fresh status, then checks them.
- **Databasmanipulation:** starts after an assumed compromise of message storage, with the original already checked by Kim. Edit **Lagrad meddelandetext**, select **Spara databasändring**, then **Simulera ny hämtning** to represent the next read from the message service. An unchanged fetch passes; altered content is rejected separately from the local original. **Ta bort posten** followed by a new fetch gives a retrieval error. The read-only publication evidence remains separate and unchanged. Reset restores the row and all reception/check state.

**Återställ** restores the selected scenario, including text, connection and evidence. Reloading returns to **Publicering**. Nothing persists. **Så fungerar verifieringen** opens a proposed-architecture explanation and a package example using current model values; it starts collapsed and expands in the normal page flow. Delivery, signing and chain checks are all local simulations, with no real hashes or signatures.

Use Tab and Enter/Space for controls and the disclosure, and standard keyboard editing in text fields. Reduced-motion preferences disable transitions. At 1280×800 or larger the phones fit side by side; smaller screens stack them. Scroll the page to read the expanded technical explanation; long messages or extended reception history can scroll within a phone.

## Model and checks

`src/model.ts` owns immutable published packets, the explicit sender/context allowlist, field comparisons, replacement references and independent integrity/authority/status results. `src/simulation.ts` separates the publisher registry, recipient-local evidence, queued deliveries, immutable received snapshots and editable copies. Reception IDs are independent of message IDs and references. Generation and revision tokens reject obsolete delivery/check callbacks after reset, scenario changes, disconnects or newer reception batches; editing a copy leaves existing callbacks and received packets intact. The storage map is untrusted and independent of publication evidence: its own verified flag travels with the response but never controls verification. Each fetch snapshots the actual stored package or a missing-row response. Reconnection also reads content from storage; the trusted registry never reconstructs a deleted message. Scenario names never determine verification results. All status data is synthetic; the offline control simulates loss of the recipient's status connection, not an offline delivery platform. The demo allowlist is the trust root, not real Swedish Red Cross authorization.

```sh
npm test
npm run build
git diff --check
```

The focused model tests cover all five scenarios, storage tampering/deletion with and without cache, frozen fetch responses and control results, direct delivery, official updates, arbitrary content/metadata changes, unknown evidence, unauthorized senders/keys, subscription context, stale status, offline catch-up, Unicode differences, editing during receipt checks, reset and obsolete callbacks. Browser verification is performed locally; no browser test runner is installed as a project dependency.
