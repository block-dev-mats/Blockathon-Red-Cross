# Blockathon Red Cross

## Problem and source

The primary project source is the Swedish Red Cross problem statement, **“Secure Crisis Communication — Misinformation, Trusted Information & Verifiable AI.”** The team currently has a supplied summary; the original PDF is not in this repository and has not been reviewed for this setup.

The problem concerns secure, scalable communication for humanitarian volunteers and crisis response, and recipient verification of information claimed to come from the Swedish Red Cross. Suggested exploration includes tamper-resistant registries, cryptographically signed official communication, on-chain provenance, and recipient-verifiable authenticity. These are possible directions, not agreed features. Beneficiary identity, biometrics, and aid payments are outside this case.

## Current state and team workflow

Product implementation has not started. This repository contains only documentation and minimal secret-file ignore rules; there is no application, test suite, or CI workflow.

The following are team working rules, not requirements attributed to the problem statement: ChatGPT supports Mats with product decisions and task contracts; Codex implements bounded assignments and delivers through GitHub. See [AGENTS.md](AGENTS.md). Priorities are low recipient friction, a reproducible demo, and explicit trust assumptions.

## Open decisions

Chain, stack, communication channel, internal versus public distribution, and wallet model remain undecided. Demo identities must not imply real organizational verification. Sullis/submission is handled separately; import support and competition requirements are unconfirmed.
