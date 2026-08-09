# Fact-check: user "NEAR Chain Signatures deep dive" paste

## Verdict
Document mixes 3 things: (1) real Chain Signatures, (2) NEAR Intents Verifier, (3) marketing hype. Several code/API claims are false.

## TRUE
- 1 NEAR account/contract can control many derived foreign addresses (ETH/BTC/SOL…)
- MPC threshold, no single full key
- Native assets on derived addresses (not wrapped)
- Smart contracts can call sign and automate
- EVM/BTC/SOL/Cosmos/XRP etc supported via ECDSA/EdDSA domains

## FALSE / misleading
- `v1.signer` method `verify_signature` — does NOT exist; real method is `sign(payload, path, domain_id)`
- Contract id `v1.signer.near` — real is `v1.signer`
- MetaMask one personal_sign → unlimited forever backend control of EXISTING wallet balances — NOT how Chain Signatures works
- "Unlimited txs one signature" without further auth — each foreign payload still needs a `sign` request from the controlling NEAR account/contract (contract can do many if IT is the controller)

## DIFFERENT product mixed in
NEAR Intents Verifier: ERC-191 / Ed25519 intent signatures (MetaMask/Phantom) for intents.execute — NOT the same as v1.signer MPC foreign-chain signing API in the paste.

## Intents chain-abstraction marketing (closer to user hope)
Connect existing wallet → MPC derives addresses on other chains → user must move assets TO derived addresses → then control via that identity model. Still not "drain old MetaMask balance with one message".
