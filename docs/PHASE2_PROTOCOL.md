# Phase 2 MCP Protocol Observation

Date: 2026-08-30

## Dependency/API compatibility

`docs/ARCHITECTURE.md` expected the v2 package split:

- `@modelcontextprotocol/server` v2
- `@modelcontextprotocol/node` v2
- Zod v4 through `zod/v4`

The npm registry reported and the installed lockfile now use:

- `@modelcontextprotocol/server` `2.0.0`
- `@modelcontextprotocol/node` `2.0.0`
- `zod` `4.5.4`

The published API exposes `McpServer`, `createMcpHandler`, `serveStdio` from
`@modelcontextprotocol/server/stdio`, and the Node adapter's
`localhostHostValidation`, `localhostOriginValidation`, and `toNodeHandler`.
The package names and required APIs are compatible with the architecture. No
architecture clarification was necessary.

## Codex observation

- Client: `codex-cli 0.151.0-alpha.7.1`
- Method: one ephemeral `codex exec` session with user configuration ignored,
  an explicit no-file-change prompt, and a local relay in front of the built
  stdio server.
- Observed initialize protocol version: `2025-06-18`
- Observed protocol era: `legacy`
- Observed transport: stdio
- Result: Codex invoked `ping` once and received the bounded Phase 2 response.

The relay recorded only the initialize method's protocol version and the era;
it did not record credentials or request contents. The server keeps the SDK's
dual-era compatibility path enabled with `serveStdio({ legacy: 'serve' })` and
`createMcpHandler({ legacy: 'stateless' })`. The observed Codex client therefore
uses the SDK's legacy compatibility path while the modern 2026-07-28 path
remains available from the same factory.

## Inspector observation

Official MCP Inspector `2.4.0` connected successfully to both transports.
For each transport, `tools/list` exposed exactly `ping`, and a manual
`tools/call` returned `ok: true` for `agent-orchestrator-mcp`. The HTTP run used
the real loopback bearer gate; missing/bad bearer requests returned `401`, and
non-local Host/Origin requests returned `403`.
