# Sub-Agent Prompt: OpenClaw × Beav3r MVP Build

You are implementing the integration in this repository.

## Core Constraint
- Do **not** treat Beav3r as executor.
- OpenClaw must remain the final enforcement and execution-resolve path.

## Build Target
Implement Option B lite with:
1. `packages/openclaw-approvals` (plugin)
2. `packages/openclaw-beav3r-bridge` (sidecar)
3. Adoption kit (`examples`, `docs`, `README`)

## Hard Contract Inputs
Use this handoff payload schema:
```json
{
  "version": "v1",
  "approvalId": "oc_appr_123",
  "actionHash": "hex_sha256",
  "action": {
    "tool": "exec",
    "command": "kubectl apply -f prod.yaml",
    "cwd": "/workspace",
    "host": "gateway",
    "node": null,
    "systemRunPlan": {}
  },
  "risk": {
    "score": 86,
    "level": "high",
    "reasons": ["prod_env", "deploy_action", "write_operation"]
  },
  "actor": {
    "agentId": "main",
    "sessionId": "agent:main:...",
    "senderId": "telegram:12345",
    "channel": "telegram"
  },
  "environment": {
    "workspace": "/Users/.../workspace",
    "hostname": "gateway-host",
    "envClass": "prod"
  },
  "expiry": 1773076400,
  "nonce": "random_128b",
  "reason": "Exec requires approval under policy",
  "callback": {
    "url": "http://plugin.local/callback/openclaw-resolve",
    "auth": { "type": "hmac-sha256", "keyId": "k1" }
  },
  "idempotencyKey": "oc_appr_123:1"
}
```

Action hash must be deterministic canonical JSON over required subset.

Bridge `/handoff` response must be exactly:
- `{ approvalId, status: "accepted", route: "beav3r", queued: true }`
or
- `{ approvalId, status: "accepted", route: "local", queued: false }`

Callback payload contract:
```json
{
  "approvalId": "oc_appr_123",
  "status": "approved",
  "decision": "allow-once",
  "decidedAt": 1773072800,
  "approver": {
    "deviceId": "device_001",
    "publicKey": "base64",
    "assurance": "software"
  },
  "signature": {
    "scheme": "ed25519",
    "value": "base64_sig_over_actionHash"
  },
  "reason": "Approved by signer",
  "expiresAt": 1773076400
}
```
Plugin must verify HMAC before resolve.

## Config Model
Support this shape (or a fully documented equivalent):
- enabled, mode, targets
- riskThresholds(localMax, beav3rMin)
- envOverrides
- fallbackPolicy(medium/high)
- beav3r(baseUrl, timeoutMs)
- bridge(callbackSecret)

## Reliability Requirements
- idempotency
- callback retry/backoff
- timeout transitions
- terminal state persistence (MVP store + pluggable interface)
- duplicate callback protection
- structured logs

## Test Minimums
- payload normalization
- hash determinism
- route local vs beav3r
- callback HMAC verification
- duplicate callback ignored
- timeout deny/expire behavior
- approval resolves after beav3r approval
- beav3r unavailable fallback behavior

## Execution Order
Follow `TASKS.md` strictly.

## Deliverables
- implementation
- docs
- examples
- tests passing
- concise runbook for Ndeto’s current setup
