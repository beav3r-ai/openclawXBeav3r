# OpenClaw × Beav3r Hash Spec (MVP v1)

## Canonical payload subset for `actionHash`
Deterministic SHA-256 over canonical JSON with **sorted object keys** and no whitespace.

Included fields only:
- `action.tool`
- `action.command`
- `action.cwd` (empty string when absent)
- `action.host` (empty string when absent)
- `action.node`
- `action.systemRunPlan` (canonicalized recursively)
- `actor.agentId`, `actor.sessionId`, `actor.senderId`, `actor.channel`
- `environment.workspace`, `environment.hostname`, `environment.envClass`
- `expiry`
- `nonce`

Excluded as non-deterministic / external:
- callback URL/auth
- risk reasons ordering noise outside action intent
- runtime transport metadata

## Pseudocode
```ts
canonical = stableStringify({tool, command, cwd, host, node, systemRunPlan, actor, environment, expiry, nonce})
actionHash = sha256(canonical).hex()
```

## Test vectors
Vector A input subset:
```json
{"tool":"exec","command":"echo ok","cwd":"/w","host":"h","node":null,"systemRunPlan":{"a":1,"b":2},"actor":{"agentId":"main","sessionId":"s","senderId":"u","channel":"telegram"},"environment":{"workspace":"/w","hostname":"h1","envClass":"prod"},"expiry":1773076400,"nonce":"n"}
```
Expected hash:
- Computed in test: `packages/openclaw-approvals/tests/plugin.test.ts`
- Determinism assertion verifies re-ordered keys produce same digest.

## Extension notes
If canonical contract expands, bump `version` and publish new vectors. Do not mutate v1 behavior.
