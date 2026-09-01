import { randomUUID } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import { assertRoleCapabilities, canonicalCapabilitiesJson, hasCapability } from '../../authority/capabilities.js';
import type { AuditWriter } from '../../authority/audit.js';
import {
  addEvidence,
  EvidenceAddInputSchema,
  EvidenceError,
  EVIDENCE_ERROR_CODES,
  EvidenceRecordSchema,
  EvidenceListInputSchema,
  listEvidence,
} from '../../domain/evidence.js';
import {
  ArtifactError,
  ARTIFACT_ERROR_CODES,
  ArtifactListInputSchema,
  ArtifactRecordSchema,
  ArtifactRegisterInputSchema,
  listArtifacts,
  registerArtifact,
} from '../../domain/artifacts.js';
import type { SqliteDatabase } from '../../store/db.js';
import type { ActorAuthInfo, VerifiedActorAuthInfo } from '../auth.js';

export interface Phase7EvidenceArtifactToolOptions {
  readonly db: SqliteDatabase;
  readonly audit: AuditWriter;
  readonly artifactsRoot: string;
  readonly leaseKey: Buffer;
  readonly clock?: () => number;
  readonly platform?: NodeJS.Platform;
}

const EvidenceAddSuccess = z.object({
  ok: z.literal(true),
  request_id: z.string().uuid(),
  evidence: EvidenceRecordSchema,
});
const ArtifactRegisterSuccess = z.object({
  ok: z.literal(true),
  request_id: z.string().uuid(),
  artifact: ArtifactRecordSchema,
});
const EvidenceListSuccess = z.object({
  ok: z.literal(true),
  request_id: z.string().uuid(),
  evidence: z.array(EvidenceRecordSchema),
  next_cursor: z.string().optional(),
});
const ArtifactListSuccess = z.object({
  ok: z.literal(true),
  request_id: z.string().uuid(),
  artifacts: z.array(ArtifactRecordSchema),
  next_cursor: z.string().optional(),
});
const EvidenceFailure = z.object({
  ok: z.literal(false),
  request_id: z.string().uuid(),
  error: z.object({ code: z.enum(EVIDENCE_ERROR_CODES), message: z.string() }),
});
const ArtifactFailure = z.object({
  ok: z.literal(false),
  request_id: z.string().uuid(),
  error: z.object({ code: z.enum(ARTIFACT_ERROR_CODES), message: z.string() }),
});

export const Phase7EvidenceAddOutput = z.discriminatedUnion('ok', [EvidenceAddSuccess, EvidenceFailure]);
export const Phase7ArtifactRegisterOutput = z.discriminatedUnion('ok', [ArtifactRegisterSuccess, ArtifactFailure]);
export const Phase7EvidenceListOutput = z.discriminatedUnion('ok', [EvidenceListSuccess, EvidenceFailure]);
export const Phase7ArtifactListOutput = z.discriminatedUnion('ok', [ArtifactListSuccess, ArtifactFailure]);

function requestId(): string {
  return randomUUID();
}

function verifiedActor(authInfo: ActorAuthInfo | undefined): VerifiedActorAuthInfo | undefined {
  if (authInfo === undefined || authInfo.actorId === undefined || authInfo.role === undefined
    || authInfo.capabilities === undefined || authInfo.clientId !== authInfo.actorId) return undefined;
  try {
    assertRoleCapabilities(authInfo.role, authInfo.capabilities);
    if (canonicalCapabilitiesJson(authInfo.capabilities) !== JSON.stringify(authInfo.capabilities)) return undefined;
  } catch {
    return undefined;
  }
  return authInfo as VerifiedActorAuthInfo;
}

function mutationActor(
  authInfo: ActorAuthInfo | undefined,
  capability: 'evidence:add' | 'artifact:register',
): VerifiedActorAuthInfo | undefined {
  const actor = verifiedActor(authInfo);
  if (actor === undefined || !hasCapability(actor.capabilities, capability)) return undefined;
  if (actor.role === 'principal') return actor.actorId === 'codex' ? actor : undefined;
  return actor.role === 'worker' ? actor : undefined;
}

function readerActor(authInfo: ActorAuthInfo | undefined): VerifiedActorAuthInfo | undefined {
  const actor = verifiedActor(authInfo);
  return actor !== undefined && (actor.role === 'principal' || actor.role === 'observer')
    && hasCapability(actor.capabilities, 'job:read') ? actor : undefined;
}

function evidenceFailure(error: unknown, id: string): z.infer<typeof EvidenceFailure> {
  if (error instanceof EvidenceError) return { ok: false, request_id: id, error: { code: error.code, message: error.message } };
  return { ok: false, request_id: id, error: { code: 'INTERNAL_ERROR', message: 'The evidence operation failed.' } };
}

function artifactFailure(error: unknown, id: string): z.infer<typeof ArtifactFailure> {
  if (error instanceof ArtifactError) return { ok: false, request_id: id, error: { code: error.code, message: error.message } };
  return { ok: false, request_id: id, error: { code: 'INTERNAL_ERROR', message: 'The artifact operation failed.' } };
}

function success<T>(value: T): { readonly content: [{ readonly type: 'text'; readonly text: string }]; readonly structuredContent: T } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

/** Registers the Phase 7 evidence/artifact surface for one verified actor. */
export function registerPhase7EvidenceArtifactTools(
  server: McpServer,
  options: Phase7EvidenceArtifactToolOptions,
  authInfo: ActorAuthInfo | undefined,
): void {
  const evidenceActor = mutationActor(authInfo, 'evidence:add');
  if (evidenceActor !== undefined) {
    server.registerTool(
      'evidence_add',
      {
        title: 'Add Evidence',
        description: 'Append one bounded, server-classified observation to a job cycle.',
        inputSchema: EvidenceAddInputSchema,
        outputSchema: Phase7EvidenceAddOutput,
      },
      async (input) => {
        const id = requestId();
        try {
          return success({ ok: true, request_id: id, evidence: addEvidence(
            options.db,
            options.audit,
            evidenceActor,
            input,
            id,
            options,
          ) });
        } catch (error) {
          return success(evidenceFailure(error, id));
        }
      },
    );
  }

  const artifactActor = mutationActor(authInfo, 'artifact:register');
  if (artifactActor !== undefined) {
    server.registerTool(
      'artifact_register',
      {
        title: 'Register Artifact',
        description: 'Copy one bounded file into the orchestrator artifact store and record its metadata.',
        inputSchema: ArtifactRegisterInputSchema,
        outputSchema: Phase7ArtifactRegisterOutput,
      },
      async (input) => {
        const id = requestId();
        try {
          return success({ ok: true, request_id: id, artifact: registerArtifact(
            options.db,
            options.audit,
            artifactActor,
            input,
            id,
            options,
          ) });
        } catch (error) {
          return success(artifactFailure(error, id));
        }
      },
    );
  }

  const reader = readerActor(authInfo);
  if (reader !== undefined) {
    server.registerTool(
      'evidence_list',
      {
        title: 'List Evidence',
        description: 'Read bounded evidence metadata for a job cycle.',
        inputSchema: EvidenceListInputSchema,
        outputSchema: Phase7EvidenceListOutput,
      },
      async (input) => {
        const id = requestId();
        try {
          const result = listEvidence(options.db, reader, input);
          return success({ ok: true, request_id: id, ...result });
        } catch (error) {
          return success(evidenceFailure(error, id));
        }
      },
    );
    server.registerTool(
      'artifact_list',
      {
        title: 'List Artifacts',
        description: 'Read bounded artifact metadata without returning file bytes.',
        inputSchema: ArtifactListInputSchema,
        outputSchema: Phase7ArtifactListOutput,
      },
      async (input) => {
        const id = requestId();
        try {
          const result = listArtifacts(options.db, reader, input);
          return success({ ok: true, request_id: id, ...result });
        } catch (error) {
          return success(artifactFailure(error, id));
        }
      },
    );
  }
}
