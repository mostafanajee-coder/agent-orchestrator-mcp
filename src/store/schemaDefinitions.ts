import { createHash } from 'node:crypto';

export const CANONICAL_SCHEMA_DEFINITIONS = {
  tables: {
    actor_tokens: '869ccebd6ed186aaff91b06c50c9aea40fb6dca0eda586f34496e0b6508e224d',
    actors: 'bf3d612f78feceab9daf29ac1b155a9c78d468297755ea010e7b3e5e00543e6b',
    artifacts: 'b451a5634acbbff346bd5a600a70549d2a37a88cd2029f5e01cf9938aedd75aa',
    audit_log: 'c932a59f696a8b8a37015d02826fc78134b6b0d682eee647a6ff495ab448dcfa',
    authoritative_statuses: '3b2f056d05f8f6c97eb042a81b120ad8cab1da29e715a1efff887e5951ab869f',
    decision_grants: '4d417f899301242b5b71343ccaa732b17d4550226bff6c9fdd9020f52014267e',
    decisions: 'd5255839b3929be8f6118ab1210d9f3d86d58dd2f57f39abae9b9c4feaac8efd',
    evidence: 'db969505559585e5f3ead0ab07598effe8e8201015d66dcf8b79abb3ef1dac09',
    idempotency: '311ff260427cc143ed647ef4a42517beeb60d6fae0ef9bbf02a83dfdf5ddc1bd',
    jobs: '1832eba1c3357d3a25ea245550c034126f3053d32c0a07b08d704e653ea05b58',
    leases: '2e1f84faba1938578c48e1b269f692aa4582d89c39445a095d55d9d0d89f40a5',
    schema_migrations: '4cdeb4f4923d40c8fd96bb6e1c8b5f2e0752a2b57b0fa35680db9feced28f627',
    worker_runs: '6f6b89bdbdbc1d17776245f0ea2709e1b1801f15cb1ae87254bf7b6472eeb1c6',
  },
  indexes: {
    ix_actor_tokens_actor: '6f7d8e9604935da3fb14cb39210d7d85d33d7b1dae5e5e018f1c15ac39a7a95d',
    ix_audit_job: '39df0dee23f31770670a63326c1c981e62813e8c88118e90b02aea13dc21829b',
    ix_audit_session: '107d1dffad5999a7d1f835527ac427bcbc220189ca7e9610d3ac95803c0aa99c',
    ix_decisions_job: '9fff338f157772274a1d640c541a2a0b00c6cdaa36f5ccc27646ccfed0092ef2',
    ix_decisions_session: 'afe86f2a151dc142a57e51511ef2f84903410894043c3bc2d735dc6e04d486c6',
    ix_evidence_job_cycle: 'f9c473d70409f171f1a77dba9752e16732a37b10618cfdb5778d2bd848b6e14b',
    ix_jobs_auth_status: '8e5cf3f42d4d33d32be58092af3e270f9f20ba09f16098979f5e40b0fd4657ae',
    ix_jobs_state_updated: 'e882c0d3aa33789c56c09fda0a26d60b9ec48a145cf836a6021c338b18ccb1e2',
    ix_jobs_workspace: '2e529ac56fc9cb04ebba2f6a43dfffe9f22a43e6c504475ad3b99155d22e061e',
    ix_runs_job_cycle: '45be54d0edb9efb839b216315335edddc37c876f90d41ab5f51e367f7832a805',
    ux_actors_single_principal: '534c0b7aa1ec1b47bd2a9d6baceac8c76ce28b817dd98646cafdcb40051944cd',
    ux_artifacts_job_rel_path: 'eda8b53055b6994adcfa81fdf072973ddbb3953ea6b2837ac797da1296e11fd7',
    ux_leases_run_id: '95de7518367aa6748ff9654786496e9cc750a2959f5bff7f475a4cf2b9ff8dee',
    ux_worker_runs_run_job_cycle: 'e9bbbad44bb58e126252324e126be6d9c10f2b12080a24a95c58c3ff708bd5d5',
  },
  triggers: {
    trg_audit_no_delete: '93252a5a179051622b6046e65e2c8c73bc439846e5bded16c27729fbf05e8dc6',
    trg_audit_no_replace: '0294da6c231ccd8be1d2ef7239d9869679ec36ba150c1ac62f0949daeece11cb',
    trg_audit_no_update: '5556621d1918e9d0252536fb9e366bd4f23a62a2beb4cbb9419ae1e60c36f7a7',
    trg_auth_status_monotonic: '669f6e44a416024aa24e6bc4c25f437a6c7042979733fd2ac5c0a3c341bfc230',
    trg_auth_status_requires_granting_decision: '17f9ef8e5d05b98a3309f87379db96ba6accbcd820aa5a98e654a5e1c75a6e16',
    trg_auth_statuses_frozen_d: '9a10e5d4f7433a0f41287a668ebefa659aa94e4cf71af27602c63c370c701e62',
    trg_auth_statuses_frozen_i: '8933f08fe3e55d5aad28bde9f369712bf021896082275ea4da0cf1b561605d40',
    trg_auth_statuses_frozen_u: '9d5b571737bc759bc9e382e67abbe1bb00127f09ae3a1f1b1a7f660b9d368fff',
    trg_decisions_no_delete: '7574b977171ed9e864e904c27621c9313803fcd6affd7fa4e41acaa11816a5ed',
    trg_decisions_no_replace: '62f2a9cfea2d9b847908f3e82ea5da3159236a73b1922941a2a75604c268beba',
    trg_decisions_no_update: '2675c5732b9d14dcbfb763e41518cfb1f2198fbe39bddd7ccb07b77420e17376',
    trg_decisions_principal_only: '8986eb494769791612b4fb7d6092be83ff6413f5e56d898fc5ed57dcebe827df',
    trg_grants_frozen_d: 'd537a3064677887188e04b64e693ded366ee619a74ebd4e883c0e37c8579533d',
    trg_grants_frozen_i: 'ed46123a16daa112da5a1828d6673ef740bd598f263e772a96c2e2dd3d147fa6',
    trg_grants_frozen_u: '3f122c888384d0f0192f2203b4039e3d5ed0645b3409e12f07c36612689fb34b',
    trg_jobs_no_delete: '40df3038f28a3d159b6d62eccec0ba28e22d93af8793624d6cef9c3563df7883',
    trg_jobs_no_replace: 'b9de1cd0300edaf247b3f2918445d888160b14e2e9f3787218a3153430d3eb12',
    trg_jobs_unstamped_on_insert: 'daeeb806a135d94adaa7995f488f2e57f8900da5ddf065c53fb7d65f462d8d49',
    trg_state_matches_auth_status: '13f7a365769053e869d4cffdb43094da10c2e39e6b6db30407d7dade175b6e9a',
  },
} as const;

export type SchemaObjectType = keyof typeof CANONICAL_SCHEMA_DEFINITIONS;

/**
 * Deliberately normalizes whitespace only. SQL keyword/identifier case and
 * comments remain part of the reviewed fingerprint so approved DDL changes
 * require an explicit fingerprint regeneration in the same reviewed change.
 */
export function canonicalizeSchemaSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

export function fingerprintSchemaSql(sql: string): string {
  return createHash('sha256').update(canonicalizeSchemaSql(sql)).digest('hex');
}
