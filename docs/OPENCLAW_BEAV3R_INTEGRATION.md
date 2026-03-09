# OpenClaw × Beav3r Integration (Option B lite)

## Non-negotiable constraint
Beav3r is **approval authority only**. OpenClaw remains policy gate and final enforcement via resolve adapter.

## Canonical contracts
### Handoff payload (required)
Implemented exactly as requested (v1) in `packages/openclaw-approvals/src/types/contracts.ts`.

### `/handoff` response shape
Always:
```json
{"approvalId":"...","status":"accepted","route":"beav3r|local","queued":true|false}
```

### Callback payload
Implemented in plugin + bridge contracts, HMAC signed with `x-ocb-signature`.

## Priority order (implemented per TASKS.md)
1. Canonical hash payload + determinism tests
2. Bridge `POST /handoff`
3. Plugin listener adapter for `exec.approval.requested`
4. Signed callback route
5. Resolve mapped to OpenClaw semantics (`allow_once|deny|expired|timeout`)
6. Routing policy + fallback behavior
7. Docs + examples + demo flow

## Config model support
Plugin config supports:
- `enabled`, `mode`, `targets`
- `riskThresholds.localMax`, `riskThresholds.beav3rMin`
- `envOverrides`
- `fallbackPolicy.medium/high`
- `beav3r.baseUrl`, `beav3r.timeoutMs`
- `bridge.callbackSecret`

## Reliability in MVP
- idempotency key store (in-memory + store interface)
- callback retry/backoff
- timeout -> terminal `expired`
- terminal state persistence in store
- duplicate callback ignored (plugin + bridge dedupe)
- structured logs in bridge

## TODO hooks (env-specific)
- Bind `InMemoryApprovalEventSource` to real OpenClaw `exec.approval.requested` event stream.
- Swap `NoopResolverAdapter` with real OpenClaw resolve API adapter.

## Beaver API contract used by bridge adapter
`packages/openclaw-beav3r-bridge/src/adapters/beav3r-client.ts` is aligned to:
- `POST /actions/request`
- `GET /actions/:actionId/status`
- `POST /approvals/submit`
- `POST /approvals/reject`

Decision mapping:
- `pending` -> unresolved (`null`)
- `approved | executed` -> `approved`
- `rejected | denied` -> `denied`
- `expired` -> `expired`

## MVP success criteria
- Pending OpenClaw exec approvals intercepted externally.
- Selected approvals route to Beav3r.
- Beav3r approval resolves original OpenClaw approval.
- Deny/timeout resolve correctly.
- No execution without OpenClaw resolution.
- Local path still works when Beav3r route disabled/fallback local.
