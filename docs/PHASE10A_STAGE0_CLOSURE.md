# Phase 10A Stage-0 Closure

## A. AOM state

The authoritative AOM planning repository remains the frozen Phase 10A
baseline:

- Repository: `C:\AgentProjects\agent-orchestrator-mcp`
- Branch: `codex/phase10-authority-plan`
- HEAD: `5728751fa41f3e2463e2a534ce3cefbec80a2280`
- Tree: `6131e6df9b3b52796173d00a93429ee9f4bbe3eb`
- Working tree: clean
- No AOM source, domain, store, schema, migration, or authority semantics
  were changed by Stage-0.

## B. Gateway state

The separate Stage-0 Gateway is complete at the reviewed implementation
commit:

- Repository: `C:\AgentProjects\aom-edge-gateway`
- Branch: `codex/phase10a-stage0-gateway`
- HEAD: `70e1ce24a4b4f7a45cb1d350c28c43b438ca4b89`
- Tree: `b7e752f6683a24c7bcd594aebda9a14c31c2b76e`
- Working tree: clean
- `npm run ci`: PASS, 18/18 tests
- `npm audit --omit=dev`: 0 vulnerabilities

The Gateway listens only on `127.0.0.1:4318`. AOM listens only on
`127.0.0.1:4317`. Tailscale Funnel forwards only to the Gateway listener.

## C. Gate A/B/C verification

### Gate A — local Gateway to AOM

PASS. The Gateway reached the loopback AOM MCP endpoint and returned the
read-only `ping` projection. Authentication and the fixed downstream route
were exercised without exposing an AOM credential externally.

### Gate B — external HTTPS through Funnel

PASS. HTTPS through the public Tailscale Funnel endpoint reached the Gateway,
which reached AOM through loopback. Protected-resource discovery, OAuth
metadata, MCP transport, filtered tool listing, read-only calls, malformed
requests, excluded tools, upstream failure handling, restart behavior, and
Funnel disable/enable behavior were exercised. AOM was never exposed directly.

### Gate C — ordinary ChatGPT Plus

PASS. The ordinary consumer ChatGPT product completed the OAuth flow and
invoked `ping` from a normal Chat conversation. ChatGPT displayed:

```text
Called tool
Ping successful: ok: true
```

ChatGPT Work was not required for the successful invocation.

## D. Real ChatGPT Plus evidence

The observed end-to-end path was:

```text
ChatGPT Plus ordinary Chat
  -> AOM Stage-0 Read custom plugin
  -> OAuth 2.1 at the Gateway
  -> Tailscale Funnel HTTPS
  -> Stage-0 Edge Gateway
  -> AOM loopback MCP /mcp
```

The following were observed or verified without recording secrets:

- public Server URL with the `/mcp` path;
- OAuth authorization and callback completion;
- dynamic client registration (DCR);
- PKCE authorization-code exchange;
- MCP discovery and legacy initialization fallback;
- successful `ping` invocation from ordinary ChatGPT;
- no OpenAI API model call was used for the integration test;
- no AOM principal bearer was entered into ChatGPT.

## E. Compatibility findings learned during Gate C

The following are empirical compatibility corrections, distinct from the
original planned architecture:

1. ChatGPT issued `server/discover` before the legacy `initialize` handshake.
   The Gateway now returns the compatible `404` / JSON-RPC `-32601` fallback,
   allowing ChatGPT to continue with `initialize` and `tools/list`.
2. A ten-minute edge access-token lifetime was impractical for a normal
   ChatGPT session. Stage-0 now uses a one-hour in-memory read-token lifetime.
3. ChatGPT reuses its DCR client identifier across a Gateway restart. The
   Gateway now recovers the issued-shaped client identifier only when the
   redirect remains an allowlisted ChatGPT redirect; owner approval and PKCE
   remain mandatory.
4. Chrome blocked the owner-secret form submission with a client-side browser
   error during testing. The approved local OAuth completion path was used to
   finish the test; this did not require weakening Gateway authentication.

These are empirically verified product and browser behaviors. They do not
authorize expanding the Stage-0 public surface or changing AOM authority.

## F. Public tool surface

Exactly these four read-only tools were discovered by ChatGPT:

- `ping`
- `job_list`
- `job_get`
- `run_status`

The Gateway remains default-deny. `codex_decide`, all write tools, worker
dispatch, evidence/artifact mutation, and future or unlisted tools remain
unavailable.

## G. Security invariants

- AOM remains loopback-only.
- Funnel exposes the Gateway only, never AOM directly.
- The downstream AOM URL remains fixed in Gateway source.
- External authentication is OAuth 2.1 with owner approval and PKCE.
- The AOM bearer credential remains local to the Gateway process.
- Owner secrets, bearer tokens, OAuth codes, and private credentials are not
  present in this evidence.
- Public responses are safe projections and do not expose private job content,
  filesystem paths, internal worker identifiers, or authority rationale.
- Write, worker, and authority tools are rejected before downstream forwarding.
- No browser worker, remote worker, scheduler, autonomous retry, or deployment
  work was introduced.

## H. Confused-deputy limitation

The Stage-0 limitation remains open and is not closed by this connectivity
success. The Gateway's interior credential ultimately resolves to the full
AOM principal. Therefore Stage-0 is temporary read-only containment only.

This closure does not authorize or justify internet-facing access to:

- `job_create`;
- `job_start`;
- `job_resume`;
- `qa_dispatch`;
- `codex_decide`;
- any other mutating or authority operation.

Future write/control work requires a separately reviewed server-verified
scoped-delegation architecture.

## I. Documentation changes

This document is the minimum dedicated closure record for the completed
Phase 10A Stage-0 connectivity gate. Historical Phase 3–9 documents were not
rewritten.

## J. Closure commit

This document is intended to be committed in one documentation-only AOM
commit. The commit SHA and tree are recorded in the final report after the
commit is created and verified. No push, PR, merge, or deployment is part of
this closure.

## K. Live state at closure

- Funnel: enabled and forwarding only to `127.0.0.1:4318`.
- Gateway: running on `127.0.0.1:4318`.
- AOM: running on `127.0.0.1:4317`.
- ChatGPT Plugin: connected through OAuth.
- Ordinary ChatGPT `ping`: verified successfully.

The live integration may remain enabled for bounded read-only use. It must
not be used as authorization for any write or authority operation.

## L. Next architecture gate

The next separate problem is **Phase 10B — Write-Control Delegation**.

Its objective is to allow future bounded mutations and authority operations
without giving an internet-facing Gateway unrestricted principal authority.
The candidate direction remains **server-verified scoped delegation**.

Phase 10B design, implementation, write exposure, and authority exposure are
not part of this closure and have not started.

```text
PHASE 10A GATE A: PASS
PHASE 10A GATE B: PASS
PHASE 10A GATE C: PASS

CHATGPT PLUS -> AOM READ CONNECTIVITY: VERIFIED
STAGE-0 READ-ONLY CONNECTIVITY: COMPLETE

WRITE IMPLEMENTATION AUTHORIZED: NO
WORKER DISPATCH AUTHORIZED: NO
AUTHORITY IMPLEMENTATION AUTHORIZED: NO
CODEX_DECIDE EDGE EXPOSURE AUTHORIZED: NO
```
