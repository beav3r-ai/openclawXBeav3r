# OpenClaw × Beav3r Runtime Integration — Strict TASKS

## Guardrails (non-negotiable)
- [ ] OpenClaw remains **final policy enforcement + execution gate**.
- [ ] Beav3r is **approval authority only**.
- [ ] No execution path exists outside OpenClaw resolve callback flow.

---

## 1) Runtime Adapter Wiring (replace harness fakes)

### 1.1 Real event-source adapter
**Target files**
- `packages/openclaw-approvals/src/adapters/openclaw-event-source.ts` (new)
- `packages/openclaw-approvals/src/adapters/event-source.ts` (keep in-memory fallback)

**Subtasks**
- [ ] Define runtime event bus interface for `exec.approval.requested`.
- [ ] Implement payload mapper `mapOpenClawApprovalRequestedEvent(payload)`.
- [ ] Validate malformed payloads and throw deterministic errors.
- [ ] Preserve/normalize fields required by handoff contract (`approvalId`, `action`, `risk`, `actor`, `environment`, `expiry`, `nonce`, `idempotencyKey`).

### 1.2 Real resolver adapter
**Target files**
- `packages/openclaw-approvals/src/adapters/openclaw-resolver.ts` (new)
- `packages/openclaw-approvals/src/adapters/resolver.ts` (keep noop fallback for harness)

**Subtasks**
- [ ] Define runtime approvals API interface (`resolveApproval`).
- [ ] Implement mapping helper from plugin resolve input to runtime resolve input.
- [ ] Preserve OpenClaw `approvalId` and mapped decision semantics (`allow_once|deny|expired|timeout`).

### 1.3 Runtime entrypoint + plugin path wiring
**Target files**
- `packages/openclaw-approvals/src/runtime/openclaw-runtime.ts` (new)
- `packages/openclaw-approvals/src/server.ts`
- `packages/openclaw-approvals/src/index.ts`

**Subtasks**
- [ ] Create `bindOpenClawRuntime({ runtime, config, callbackUrl })`.
- [ ] Wire runtime path in server when runtime object is available.
- [ ] Keep in-memory/noop harness path as fallback for local demo/tests.
- [ ] Export runtime adapter entrypoints from package index.

---

## 2) Observability (required lifecycle logs)

**Target files**
- `packages/openclaw-approvals/src/plugin.ts`

**Subtasks**
- [ ] Log `approval.event_received`.
- [ ] Log `approval.handoff_sent`.
- [ ] Log `approval.route_chosen`.
- [ ] Log `approval.callback_received`.
- [ ] Log `approval.resolve_called`.
- [ ] Log `approval.resolve_result`.

---

## 3) Bridge change policy (minimal-only)

**Target files**
- `packages/openclaw-beav3r-bridge/src/bridge.ts`
- `packages/openclaw-beav3r-bridge/src/adapters/beav3r-client.ts`

**Subtasks**
- [ ] Keep bridge behavior unchanged unless needed for metadata/auth/logging/persistence hooks.
- [ ] Do not redesign routing/state machine.
- [ ] Preserve existing fallback semantics for Beav3r unavailability.

---

## 4) Acceptance Test Matrix

### 4.1 OpenClaw approvals package tests
**Target files**
- `packages/openclaw-approvals/tests/runtime-adapters.test.ts` (new)
- `packages/openclaw-approvals/tests/callback.test.ts` (existing)
- `packages/openclaw-approvals/tests/plugin.test.ts` (existing)

**Subtasks**
- [ ] Real-event payload mapping test.
- [ ] Malformed payload negative test.
- [ ] Real-resolve adapter mapping test.
- [ ] Event → handoff → callback → resolve integration test.
- [ ] Duplicate callback protection test.

### 4.2 Bridge integration tests
**Target files**
- `packages/openclaw-beav3r-bridge/tests/bridge.test.ts`

**Subtasks**
- [ ] Beav3r unavailable fallback behavior test.
- [ ] Duplicate callback protection test.
- [ ] End-to-end callback resolve integration test.

---

## 5) Final acceptance checklist (Definition of Done)
- [ ] Runtime adapters exist and are wired through plugin runtime entry.
- [ ] Plugin emits lifecycle observability logs for all required checkpoints.
- [ ] All required tests pass across both packages.
- [ ] OpenClaw remains final enforcement path; no direct execution bypass introduced.
- [ ] Local harness path still works for dev/demo without runtime APIs.
- [ ] Export surface includes new runtime adapters and entrypoint.
- [ ] Exact local run instructions documented (install, test, run plugin/bridge).
