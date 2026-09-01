import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { AuditWriter } from '../authority/audit.js';
import type { SqliteDatabase } from '../store/db.js';
import { addRuntimeEvidence } from '../domain/evidence.js';
import { ensureArtifactStagingDirectory, registerRuntimeArtifact } from '../domain/artifacts.js';
import {
  loadRunForRuntime,
  renderWorkerArguments,
  settleRuntimeRun,
  setRunPid,
  setRunStderr,
  startRun,
  type Phase6RunOptions,
  type RunFailureClass,
  type RunSummary,
} from '../domain/runs.js';
import {
  parseWorkerMessage,
  serializeStartEnvelope,
  WorkerProtocolError,
  type WorkerArtifactMessage,
  type WorkerEvidenceMessage,
  type WorkerMessage,
} from './protocol.js';
import type { WorkerDefinitionFile } from '../config/phase6.js';

const MAX_LINE_BYTES = 65_536;
const MAX_STDERR_BYTES = 65_536;
const MAX_MESSAGES = 256;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const TERMINATION_GRACE_MS = 1_000;

interface ActiveRun {
  readonly run: RunSummary;
  readonly worker: WorkerDefinitionFile;
  readonly lease: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly artifactStagingDir?: string;
  buffer: Buffer;
  totalOutputBytes: number;
  messageCount: number;
  readySeen: boolean;
  lastProgressSeq: number;
  terminal: WorkerMessage | undefined;
  protocolFailure: string | undefined;
  stderrTail: Buffer;
  readonly evidenceMessages: WorkerEvidenceMessage[];
  readonly artifactMessages: WorkerArtifactMessage[];
  timeoutTimer: NodeJS.Timeout | undefined;
  forceTimer: NodeJS.Timeout | undefined;
  timedOut: boolean;
  cancelled: boolean;
  settled: boolean;
}

export interface ProcessRuntimeDependencies extends Phase6RunOptions {
  readonly db: SqliteDatabase;
  readonly audit: AuditWriter;
  readonly reportEndpoint?: string;
  readonly artifactsRoot?: string;
}

function nowRequestId(): string {
  return `runtime-${randomUUID()}`;
}

function boundedEnvironment(names: readonly string[]): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function failureClass(value: string): RunFailureClass {
  return value === 'SPAWN_FAILED' || value === 'TRANSIENT' || value === 'AUTH_REQUIRED'
    || value === 'MALFORMED_OUTPUT' || value === 'TIMEOUT' || value === 'MODEL_ERROR'
    ? value
    : 'MALFORMED_OUTPUT';
}

function lineBytes(value: Buffer): number {
  return value.byteLength;
}

function signalProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      // The child is spawned detached on POSIX, so its PID is also the
      // process-group ID. A negative PID signals the complete worker tree.
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if it exited between the checks.
    }
  }
  child.kill(signal);
}

function redactRuntimeText(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/(authorization|password|secret|credential|token|api[_-]?key|lease[_-]?key)\s*[:=]\s*[^,;\s}]+/gi, '$1=[REDACTED]');
}

/**
 * Owns process creation and protocol normalization for Phase 6. It never
 * chooses a job decision and never exposes its in-memory lease map.
 */
export class ProcessRuntime {
  private readonly active = new Map<string, ActiveRun>();

  public constructor(private readonly dependencies: ProcessRuntimeDependencies) {}

  /** Starts all newly admitted runs after their dispatch transaction commits. */
  public startRuns(
    runs: readonly { readonly run_id: string; readonly lease: string }[],
  ): void {
    for (const run of runs) void this.startOne(run.run_id, run.lease);
  }

  /** Sends controlled cancellation to processes for one job. */
  public cancelJob(jobId: string): void {
    for (const active of this.active.values()) {
      if (active.run.job_id !== jobId) continue;
      active.cancelled = true;
      this.terminate(active);
    }
  }

  /** Stops active processes during controlled transport shutdown. */
  public close(): void {
    for (const active of this.active.values()) {
      active.cancelled = true;
      this.terminate(active);
    }
  }

  private async startOne(runId: string, lease: string): Promise<void> {
    let loaded: ReturnType<typeof loadRunForRuntime>;
    try {
      loaded = loadRunForRuntime(this.dependencies.db, runId);
    } catch {
      return;
    }
    const worker = this.dependencies.registry.workers.find(
      (candidate) => candidate.worker_id === loaded.run.worker_id,
    );
    if (worker === undefined || !worker.enabled) return;

    let started: RunSummary;
    try {
      started = startRun(
        this.dependencies.db,
        this.dependencies.audit,
        runId,
        nowRequestId(),
        this.dependencies,
      );
    } catch {
      return;
    }

    let artifactStagingDir: string | undefined;
    if (this.dependencies.artifactsRoot !== undefined) {
      try {
        artifactStagingDir = ensureArtifactStagingDirectory(
          this.dependencies.artifactsRoot,
          started.job_id,
          started.cycle,
          started.run_id,
        );
      } catch {
        try {
          settleRuntimeRun(
            this.dependencies.db,
            this.dependencies.audit,
            lease,
            nowRequestId(),
            'FAILED',
            'NONE',
            'SPAWN_FAILED',
            null,
            undefined,
            null,
            this.dependencies,
          );
        } catch {
          // Preserve the runtime failure in the run state when possible.
        }
        return;
      }
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        worker.executable,
        renderWorkerArguments(worker, started),
        {
          cwd: loaded.workspace,
          env: boundedEnvironment(worker.environment_allowlist),
          shell: false,
          detached: process.platform !== 'win32',
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    } catch {
      try {
        settleRuntimeRun(
          this.dependencies.db,
          this.dependencies.audit,
          lease,
          nowRequestId(),
          'FAILED',
          'NONE',
          'SPAWN_FAILED',
          null,
          undefined,
          null,
          this.dependencies,
        );
      } catch {
        // The original runtime failure remains represented by the run state.
      }
      return;
    }

    const active: ActiveRun = {
      run: started,
      worker,
      lease,
      child,
      ...(artifactStagingDir === undefined ? {} : { artifactStagingDir }),
      buffer: Buffer.alloc(0),
      totalOutputBytes: 0,
      messageCount: 0,
      readySeen: false,
      lastProgressSeq: 0,
      terminal: undefined,
      protocolFailure: undefined,
      stderrTail: Buffer.alloc(0),
      evidenceMessages: [],
      artifactMessages: [],
      timeoutTimer: undefined,
      forceTimer: undefined,
      timedOut: false,
      cancelled: false,
      settled: false,
    };
    this.active.set(runId, active);
    try {
      if (child.pid !== undefined) setRunPid(this.dependencies.db, runId, child.pid);
    } catch {
      active.protocolFailure = 'SPAWN_FAILED';
      this.terminate(active);
    }

    child.stdout.on('data', (chunk: Buffer | string) => {
      this.consumeStdout(active, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      const next = Buffer.concat([active.stderrTail, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      active.stderrTail = next.byteLength > MAX_STDERR_BYTES
        ? next.subarray(next.byteLength - MAX_STDERR_BYTES)
        : next;
    });
    child.once('error', () => {
      if (!active.settled) {
        active.protocolFailure = 'SPAWN_FAILED';
        this.terminate(active);
      }
    });
    child.once('close', (code) => {
      this.finish(active, code);
    });

    try {
      const deadline = new Date(
        (this.dependencies.clock ?? (() => Date.now()))() + loaded.request.timeout_ms,
      ).toISOString();
      const envelope = serializeStartEnvelope({
        type: 'start',
        protocol_version: 1,
        run_id: started.run_id,
        job_id: started.job_id,
        cycle: started.cycle,
        worker_id: started.worker_id,
        task: loaded.request.task,
        params: loaded.request.params,
        workspace: loaded.workspace,
        deadline_at: loaded.deadline_at ?? deadline,
        ...(artifactStagingDir === undefined ? {} : { artifact_staging_dir: artifactStagingDir }),
        ...(loaded.request.delivery === 'mcp_pull'
          ? {
            lease,
            ...(this.dependencies.reportEndpoint === undefined
              ? {}
              : { report_endpoint: this.dependencies.reportEndpoint }),
          }
          : {}),
      });
      child.stdin.end(envelope);
      active.timeoutTimer = setTimeout(() => {
        active.timedOut = true;
        this.terminate(active);
      }, loaded.request.timeout_ms);
    } catch {
      active.protocolFailure = 'MALFORMED_OUTPUT';
      this.terminate(active);
    }
  }

  private consumeStdout(active: ActiveRun, chunk: Buffer): void {
    if (active.settled) return;
    active.totalOutputBytes += chunk.byteLength;
    const outputLimit = Math.min(active.worker.max_output_bytes, MAX_STDOUT_BYTES);
    if (active.totalOutputBytes > outputLimit) {
      active.protocolFailure = 'MALFORMED_OUTPUT';
      this.terminate(active);
      return;
    }
    active.buffer = Buffer.concat([active.buffer, chunk]);
    if (active.buffer.byteLength > MAX_LINE_BYTES && !active.buffer.includes(0x0a)) {
      active.protocolFailure = 'MALFORMED_OUTPUT';
      this.terminate(active);
      return;
    }
    for (;;) {
      const newline = active.buffer.indexOf(0x0a);
      if (newline === -1) return;
      const line = active.buffer.subarray(0, newline);
      active.buffer = active.buffer.subarray(newline + 1);
      const content = line.byteLength > 0 && line[line.byteLength - 1] === 0x0d
        ? line.subarray(0, line.byteLength - 1)
        : line;
      if (lineBytes(content) > MAX_LINE_BYTES) {
        active.protocolFailure = 'MALFORMED_OUTPUT';
        this.terminate(active);
        return;
      }
      active.messageCount += 1;
      if (active.messageCount > Math.min(active.worker.max_messages, MAX_MESSAGES)) {
        active.protocolFailure = 'MALFORMED_OUTPUT';
        this.terminate(active);
        return;
      }
      let message: WorkerMessage;
      try {
        message = parseWorkerMessage(content.toString('utf8'));
      } catch (error) {
        active.protocolFailure = error instanceof WorkerProtocolError
          ? 'MALFORMED_OUTPUT'
          : 'MALFORMED_OUTPUT';
        this.terminate(active);
        return;
      }
      this.acceptMessage(active, message);
      if (active.protocolFailure !== undefined) {
        this.terminate(active);
        return;
      }
    }
  }

  private acceptMessage(active: ActiveRun, message: WorkerMessage): void {
    if (active.terminal !== undefined) {
      active.protocolFailure = 'MALFORMED_OUTPUT';
      return;
    }
    if (message.type === 'ready') {
      if (active.readySeen || active.messageCount !== 1 || message.run_id !== active.run.run_id
        || message.worker_id !== active.run.worker_id) {
        active.protocolFailure = 'MALFORMED_OUTPUT';
        return;
      }
      active.readySeen = true;
      return;
    }
    if (message.type === 'progress') {
      if (message.seq <= active.lastProgressSeq) {
        active.protocolFailure = 'MALFORMED_OUTPUT';
        return;
      }
      active.lastProgressSeq = message.seq;
      return;
    }
    if (message.type === 'artifact') {
      if (active.artifactMessages.some((candidate) => candidate.path === message.path)) {
        active.protocolFailure = 'MALFORMED_OUTPUT';
        return;
      }
      active.artifactMessages.push(message);
      return;
    }
    if (message.type === 'evidence') {
      active.evidenceMessages.push(message);
      return;
    }
    active.terminal = message;
  }

  private terminate(active: ActiveRun): void {
    if (active.settled) return;
    try {
      if (process.platform === 'win32' && active.child.pid !== undefined) {
        const killer = spawn('taskkill', ['/pid', String(active.child.pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.on('error', () => signalProcessGroup(active.child, 'SIGTERM'));
      } else {
        signalProcessGroup(active.child, 'SIGTERM');
      }
    } catch {
      // The close event still settles the run using the recorded reason.
    }
    if (active.forceTimer === undefined) {
      active.forceTimer = setTimeout(() => {
        try {
          signalProcessGroup(active.child, 'SIGKILL');
        } catch {
          // Process already exited.
        }
      }, TERMINATION_GRACE_MS);
    }
  }

  private finish(active: ActiveRun, code: number | null): void {
    if (active.settled) return;
    active.settled = true;
    this.active.delete(active.run.run_id);
    if (active.timeoutTimer !== undefined) clearTimeout(active.timeoutTimer);
    if (active.forceTimer !== undefined) clearTimeout(active.forceTimer);

    if (active.timedOut) {
      this.settle(active, 'TIMEOUT', 'NONE', 'TIMEOUT', null, code);
      return;
    }
    if (active.cancelled) {
      this.settle(active, 'CANCELLED', 'NONE', null, null, code);
      return;
    }
    if (active.protocolFailure === 'SPAWN_FAILED') {
      this.settle(active, 'FAILED', 'NONE', 'SPAWN_FAILED', null, code);
      return;
    }
    if (active.protocolFailure !== undefined || active.buffer.byteLength > 0) {
      this.settle(active, 'MALFORMED', 'NONE', 'MALFORMED_OUTPUT', null, code);
      return;
    }
    const terminal = active.terminal;
    if (terminal?.type === 'error') {
      this.settle(active, 'FAILED', 'NONE', failureClass(terminal.class), null, code);
      return;
    }
    if (terminal?.type !== 'result') {
      this.settle(active, code === 0 ? 'MALFORMED' : 'FAILED', 'NONE', code === 0 ? 'MALFORMED_OUTPUT' : 'MODEL_ERROR', null, code);
      return;
    }
    if (code !== 0) {
      this.settle(active, 'FAILED', 'NONE', 'MODEL_ERROR', null, code);
      return;
    }
    this.settle(
      active,
      'SUCCEEDED',
      terminal.verdict,
      null,
      terminal.summary,
      code,
      terminal.usage,
    );
  }

  private settle(
    active: ActiveRun,
    status: 'SUCCEEDED' | 'FAILED' | 'TIMEOUT' | 'CANCELLED' | 'MALFORMED',
    verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'NONE',
    failure: RunFailureClass | null,
    summary: string | null,
    code: number | null,
    usage?: Record<string, number>,
  ): void {
    let effectiveStatus = status;
    let effectiveVerdict = verdict;
    let effectiveFailure = failure;
    let effectiveSummary = summary;
    try {
      this.recordWorkerOutputs(active);
    } catch {
      effectiveStatus = 'MALFORMED';
      effectiveVerdict = 'NONE';
      effectiveFailure = 'MALFORMED_OUTPUT';
      effectiveSummary = null;
    }
    try {
      if (active.stderrTail.byteLength > 0) {
        setRunStderr(
          this.dependencies.db,
          active.run.run_id,
          redactRuntimeText(active.stderrTail.toString('utf8')),
        );
      }
      settleRuntimeRun(
        this.dependencies.db,
        this.dependencies.audit,
        active.lease,
        nowRequestId(),
        effectiveStatus,
        effectiveVerdict,
        effectiveFailure,
        effectiveSummary,
        usage,
        code,
        this.dependencies,
      );
    } catch {
      // Preserve the original run state and keep the process runtime from
      // taking down the transport after a concurrent terminal report.
    }
  }

  private recordWorkerOutputs(active: ActiveRun): void {
    if (active.evidenceMessages.length === 0 && active.artifactMessages.length === 0) return;
    if (this.dependencies.artifactsRoot === undefined || active.artifactStagingDir === undefined) {
      throw new Error('Phase 7 worker output requires an artifact staging directory.');
    }
    const artifactIds = new Map<string, string>();
    for (const message of active.artifactMessages) {
      const record = registerRuntimeArtifact(
        this.dependencies.db,
        this.dependencies.audit,
        active.lease,
        {
          job_id: active.run.job_id,
          cycle: active.run.cycle,
          run_id: active.run.run_id,
          source_path: message.path,
          kind: message.kind,
          ...(message.mime === undefined ? {} : { mime: message.mime }),
          ...(message.label === undefined ? {} : { label: message.label }),
        },
        nowRequestId(),
        {
          artifactsRoot: this.dependencies.artifactsRoot,
          leaseKey: this.dependencies.leaseKey,
          allowExpired: true,
          ...(this.dependencies.clock === undefined ? {} : { clock: this.dependencies.clock }),
        },
      );
      artifactIds.set(message.path, record.artifact_id);
    }
    for (const message of active.evidenceMessages) {
      const artifactId = message.artifact_path === undefined
        ? undefined
        : artifactIds.get(message.artifact_path);
      if (message.artifact_path !== undefined && artifactId === undefined) {
        throw new Error('The worker evidence references an unknown artifact path.');
      }
      addRuntimeEvidence(
        this.dependencies.db,
        this.dependencies.audit,
        active.lease,
        {
          job_id: active.run.job_id,
          cycle: active.run.cycle,
          run_id: active.run.run_id,
          kind: message.kind,
          ...(message.severity === undefined ? {} : { severity: message.severity }),
          summary: message.summary,
          ...(message.detail === undefined ? {} : { detail: message.detail }),
          ...(artifactId === undefined ? {} : { artifact_id: artifactId }),
        },
        nowRequestId(),
        {
          leaseKey: this.dependencies.leaseKey,
          allowExpired: true,
          ...(this.dependencies.clock === undefined ? {} : { clock: this.dependencies.clock }),
        },
      );
    }
  }
}
