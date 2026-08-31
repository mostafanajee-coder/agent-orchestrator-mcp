export {
  closeDatabase,
  databasePaths,
  openDatabaseForInit,
  openExistingDatabaseForServe,
  removeFreshDatabaseFiles,
  verifyPragmaPolicy,
  withImmediateTransaction,
  type DatabaseOpenDependencies,
  type DatabasePaths,
  type OpenDatabaseResult,
  type SqliteDatabase,
  type SqliteDatabaseOpener,
  type SqlitePragmaPolicy,
  type SynchronousTransactionCallback,
} from './db.js';
export {
  discoverMigrations,
  KNOWN_MIGRATION_VERSIONS,
  readMigrationLedger,
  runMigrations,
  validateAppliedPrefix,
  type Migration,
  type MigrationLedger,
  type MigrationRunOptions,
  type MigrationRunResult,
} from './migrations.js';
export {
  verifyDatabaseIntegrity,
  EXPECTED_INDEXES,
  EXPECTED_TABLES,
  EXPECTED_TRIGGERS,
  type IntegrityReport,
} from './integrity.js';
export {
  CANONICAL_SCHEMA_DEFINITIONS,
  canonicalizeSchemaSql,
  fingerprintSchemaSql,
} from './schemaDefinitions.js';
export {
  createStructuralRepositories,
  type ActorRepository,
  type ActorRow,
  type ActorTokenRepository,
  type ActorTokenRow,
  type AuthoritativeStatusRow,
  type DecisionGrantRow,
  type ReferenceRepository,
  type StructuralRepositories,
} from './repositories.js';
