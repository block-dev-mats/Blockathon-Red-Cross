# Blockathon Red Cross

## Problem and source

The primary project source is the Swedish Red Cross problem statement, **“Secure Crisis Communication — Misinformation, Trusted Information & Verifiable AI.”** The team currently has a supplied summary; the original PDF is not in this repository and has not been reviewed for this setup.

The problem concerns secure, scalable communication for humanitarian volunteers and crisis response, and recipient verification of information claimed to come from the Swedish Red Cross. Suggested exploration includes tamper-resistant registries, cryptographically signed official communication, on-chain provenance, and recipient-verifiable authenticity. These are possible directions, not agreed features. Beneficiary identity, biometrics, and aid payments are outside this case.

## Current state and team workflow

The repository now contains a local interactive concept prototype for team discussion: three simultaneous views show an authorized coordinator, a forwarded copy outside the official publishing flow, and a volunteer receiving automatically checked messages. All roles and scenarios are fictional. Signing and chain checks are simulated, without cryptography, backend, external integrations or official organizational verification. There is no CI workflow.

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

The Swedish scenario buttons prepare a starting state; nothing plays automatically. Use **Publicera** and **Vidarebefordra** to drive events:

- **Oförändrat:** edit the initial message if desired, publish, then forward. The volunteer checks it automatically.
- **Ändrad kopia:** starts with a published 14.00 original and an editable 16.00 copy. Forward the copy, or enter any other text, to compare it with the original. Restore the original text to demonstrate an intact copy in the same scenario.
- **Officiell uppdatering:** starts with version 1 already received and checked. Publish the prepared 16.00 update, then forward it. The earlier version becomes replaced.
- **Utan uppkoppling:** starts with a message checked at the fictional time 13.50. Select **Koppla från volontären**. You can publish an update while disconnected, but forwarding is blocked. **Återanslut volontären** automatically refreshes the old message's status; forwarding the new version remains a separate action.

**Återställ** restores the selected scenario's starting state, including text, connection and evidence. Reloading returns to **Oförändrat**. Nothing persists. Controls support Tab and Enter/Space; text fields support standard keyboard editing. Reduced-motion preferences disable transitions. Aim for a 1280×800 or larger viewport for the simultaneous scene; smaller screens stack the views.

## Model and checks

`src/model.ts` owns immutable published packets, the explicit sender/context allowlist, field comparisons, replacement references and independent integrity/authority/status results. `src/simulation.ts` owns scenario preparation and event transitions; delayed UI checks use generation tokens so obsolete results cannot overwrite newer state. Scenario names never determine verification results. All status data is synthetic; the offline control simulates loss of the recipient's status connection, not an offline delivery platform. The demo allowlist is the trust root, not real Swedish Red Cross authorization.

```sh
npm test
npm run build
git diff --check
```

The focused model tests cover all four flows, arbitrary content/metadata changes, unknown evidence, unauthorized senders, stale status, replacement rules, Unicode differences, reset and delayed-result cancellation. Browser verification is performed locally; no browser test runner is installed as a project dependency.
