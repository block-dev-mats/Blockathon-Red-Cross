# Repository instructions

## Purpose and working model

This project explores secure crisis communication and verifiable authenticity for information claimed to originate from the Swedish Red Cross. It is not a beneficiary identity, biometrics, or aid payment project. Read [README.md](README.md) for current context and open decisions.

ChatGPT helps Mats make product decisions and define task contracts. Codex implements bounded assignments and delivers through GitHub. Follow explicit goals, scope, and trust boundaries. Choose the smallest safe implementation for discoverable details. Raise conflicting goals and decisions that are difficult to reverse; do not invent requirements or prematurely choose technology.

Read context progressively: applicable instructions, Git state, README, then directly relevant files. Do not assume access to previous chats, attachments, or the original problem statement. Distinguish supplied summaries from sources actually inspected.

Use zero subagents by default. Delegate only when authorized and concretely useful, primarily for independent read-only work. Keep one writer at a time; the main agent owns integration and delivery.

## Trust and honest demonstrations

Distinguish authenticity, content integrity, sender authorization, and current message status. A signature or on-chain record does not establish that content is true. An arbitrary wallet is not an authorized organizational sender. Define the trust root explicitly; a demo identity is not real Swedish Red Cross verification.

Verify content and interpretation-bearing fields within a defined context. Specify what the verification covers, including relevant identity, scope, and status information. Use established cryptographic libraries rather than custom cryptography.

Keep passed, failed, and unavailable verification distinct. Missing evidence, network failures, and stale caches must never produce a false green result. Do not silently treat an earlier successful check as proof of current message status.

Use synthetic scenarios. Keep secrets, personal information, and sensitive operational data out of Git, logs, CI, shared artifacts, and public chains. Clearly label mocks, testnets, and simulations. Do not claim production readiness or official organizational affiliation.

## Verification and delivery

Run focused, proportionate checks that actually exist. Prioritize the core flow, negative verification cases, and honest error states when implementation begins. Documentation changes do not require a full application test chain. Never invent commands or claim checks ran when they are absent.

Fix errors within agreed scope and report actual blockers without expanding the assignment. Review the final diff and staged content, check local links and ignore rules when affected, and run `git diff --check` plus its staged equivalent.

Preserve unrelated work. Stage only task files; do not use destructive Git cleanup or force-push. Commit and push implementation assignments unless explicitly limited to analysis or local delivery. Verify repository identity and branch policy first; use `main` for the first commit when history is absent. Confirm the remote SHA after pushing. Report changed files, checks, branch, exact commit SHA, delivery outcome, and blockers. Separate observations from assumptions.

## Browser workflow

Before opening a browser surface, check for and reuse the requested app or local server. Prefer the Codex in-app browser for ordinary interaction. Use a fresh Chrome window or isolated context only for isolated testing, a clean session, compatibility checks, or explicit requests. Release temporary surfaces afterward.
