import { describe, expect, it } from 'vitest';

import {
  parseWorkerMessage,
  serializeStartEnvelope,
  WorkerProtocolError,
} from '../../src/workers/protocol.js';

describe('Phase 6 worker protocol', () => {
  it('accepts bounded ready, progress, result, and error messages', () => {
    expect(parseWorkerMessage(JSON.stringify({
      type: 'ready', protocol_version: 1, run_id: 'run-1', worker_id: 'worker',
    }))).toMatchObject({ type: 'ready' });
    expect(parseWorkerMessage(JSON.stringify({ type: 'progress', seq: 1, message: 'working' }))).toMatchObject({ type: 'progress' });
    expect(parseWorkerMessage(JSON.stringify({ type: 'result', verdict: 'PASS', summary: 'done' }))).toMatchObject({ type: 'result', verdict: 'PASS' });
    expect(parseWorkerMessage(JSON.stringify({ type: 'error', class: 'MODEL_ERROR', message: 'failed' }))).toMatchObject({ type: 'error' });
  });

  it('rejects malformed, unknown, and oversized messages', () => {
    expect(() => parseWorkerMessage('{not-json')).toThrow(WorkerProtocolError);
    expect(() => parseWorkerMessage(JSON.stringify({ type: 'unknown' }))).toThrow(WorkerProtocolError);
    expect(() => parseWorkerMessage(JSON.stringify({ type: 'result', verdict: 'PASS', summary: 'x'.repeat(2_049) }))).toThrow(WorkerProtocolError);
    expect(() => parseWorkerMessage('x'.repeat(65_537))).toThrow(WorkerProtocolError);
  });

  it('serializes a bounded private start envelope', () => {
    const line = serializeStartEnvelope({
      type: 'start',
      protocol_version: 1,
      run_id: 'run-1',
      job_id: 'job-1',
      cycle: 0,
      worker_id: 'worker',
      task: 'run',
      params: {},
      workspace: 'C:\\AgentProjects\\fixture',
      deadline_at: '2030-01-01T00:00:00.000Z',
    });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toMatchObject({ type: 'start', protocol_version: 1 });
  });
});
