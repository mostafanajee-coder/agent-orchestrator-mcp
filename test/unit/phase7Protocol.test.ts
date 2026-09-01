import { describe, expect, it } from 'vitest';

import { parseWorkerMessage, serializeStartEnvelope, WorkerProtocolError } from '../../src/workers/protocol.js';

describe('Phase 7 worker protocol extension', () => {
  it('accepts bounded evidence and artifact messages', () => {
    expect(parseWorkerMessage(JSON.stringify({
      type: 'artifact', path: 'result.txt', kind: 'report', mime: 'text/plain', label: 'result',
    }))).toMatchObject({ type: 'artifact', path: 'result.txt' });
    expect(parseWorkerMessage(JSON.stringify({
      type: 'evidence', kind: 'assertion', severity: 'info', summary: 'result',
      detail: { ok: true }, artifact_path: 'result.txt',
    }))).toMatchObject({ type: 'evidence', artifact_path: 'result.txt' });
  });

  it('rejects unsafe or oversized Phase 7 fields', () => {
    expect(() => parseWorkerMessage(JSON.stringify({
      type: 'artifact', path: '../result.txt', kind: 'report',
    }))).not.toThrow();
    expect(() => parseWorkerMessage(JSON.stringify({
      type: 'evidence', kind: 'x'.repeat(65), summary: 'result',
    }))).toThrow(WorkerProtocolError);
    expect(() => parseWorkerMessage(JSON.stringify({
      type: 'artifact', path: 'result.txt', kind: 'report', label: 'x'.repeat(257),
    }))).toThrow(WorkerProtocolError);
  });

  it('carries the private artifact staging location in the start envelope', () => {
    const line = serializeStartEnvelope({
      type: 'start', protocol_version: 1, run_id: 'run-1', job_id: 'job-1', cycle: 0,
      worker_id: 'worker', task: 'run', params: {}, workspace: 'C:\\AgentProjects\\fixture',
      artifact_staging_dir: 'C:\\State\\artifacts\\.staging\\job-1\\0\\run-1',
      deadline_at: '2030-01-01T00:00:00.000Z',
    });
    expect(JSON.parse(line)).toHaveProperty('artifact_staging_dir');
  });
});
