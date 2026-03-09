# OpenClaw × Beav3r MVP (Option B lite)

Thin integration scaffold:
- `packages/openclaw-approvals` → plugin-side normalizer, handoff sender, signed callback receiver, resolve adapter
- `packages/openclaw-beav3r-bridge` → sidecar bridge with routing, idempotency, callbacks, retries, timeout transitions

## Quickstart (Ndeto local)
```bash
cd /Users/ndeto/.openclaw/workspace/openclawXbeav3r
npm install
npm test
npm run demo
```

## Run against a real local Beav3r
Start your Beav3r server first on `http://127.0.0.1:3000` or pass a different base URL:

```bash
cd /Users/ndeto/.openclaw/workspace/openclawXbeav3r
BEAV3R_URL=http://127.0.0.1:3000 npm run demo
```

The demo now:
- starts the plugin callback server on `127.0.0.1:7771`
- starts the bridge on `127.0.0.1:7772`
- forwards the approval to your real Beav3r instance
- polls Beav3r action status until your phone approval or denial resolves the callback

## Run as services
You can now run the bridge and plugin harness as separate long-running services:

Terminal 1:
```bash
cd /Users/ndeto/.openclaw/workspace/openclawXbeav3r
BEAV3R_URL=http://127.0.0.1:3000 npm run bridge
```

Terminal 2:
```bash
cd /Users/ndeto/.openclaw/workspace/openclawXbeav3r
BRIDGE_URL=http://127.0.0.1:7772 CALLBACK_SECRET=secret npm run plugin
```

Test the routing by posting an approval request to the plugin harness:

```bash
curl -X POST http://127.0.0.1:7771/handoff \
  -H 'content-type: application/json' \
  -d '{
    "approvalId": "oc_appr_live_001",
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
      "reasons": ["prod_env", "deploy_action"]
    },
    "actor": {
      "agentId": "main",
      "sessionId": "agent:main:test",
      "senderId": "telegram:12345",
      "channel": "telegram"
    },
    "environment": {
      "workspace": "/Users/ndeto/.openclaw/workspace",
      "hostname": "gateway-host",
      "envClass": "prod"
    },
    "expiry": 4102444800,
    "nonce": "oc_live_nonce_001",
    "reason": "Exec requires approval under policy",
    "idempotencyKey": "oc_appr_live_001:1"
  }'
```

Then check resolved decisions after approving or denying in Beav3r:

```bash
curl http://127.0.0.1:7771/resolved
```

Current note:
- the plugin service is a harness for testing routing before binding to a real OpenClaw event bus and resolver
- the bridge service is the real long-running sidecar

Expected demo output:
- `handoff response: { approvalId: 'oc_appr_demo', status: 'accepted', route: 'beav3r', queued: true }`
- resolver output includes decision `allow_once`

## Test matrix coverage
- payload normalization
- canonical hash determinism
- route local vs beav3r
- callback HMAC verification
- duplicate callback ignored
- timeout deny/expire behavior
- approval resolves correctly after beav3r approval
- beav3r unavailable fallback behavior

## Local beaver alignment
Current adapter is wired to the live beaver API contract:
- `POST {beav3r.baseUrl}/actions/request`
- `GET {beav3r.baseUrl}/actions/:actionId/status`
- `POST {beav3r.baseUrl}/approvals/submit`
- `POST {beav3r.baseUrl}/approvals/reject`

Request mapping for `createDecisionRequest(payload)`:
- `actionId <- approvalId`
- `agentId <- actor.agentId`
- `actionType <- action.tool`
- `payload <- { command, cwd, host, node, systemRunPlan, reason, risk }`
- `nonce <- payload.nonce`, `expiry <- payload.expiry`, `timestamp <- now`

## Docs
- `docs/OPENCLAW_BEAV3R_INTEGRATION.md`
- `docs/OPENCLAW_BEAV3R_HASH_SPEC.md`
- `examples/docker-compose.openclaw-beav3r.yml`
