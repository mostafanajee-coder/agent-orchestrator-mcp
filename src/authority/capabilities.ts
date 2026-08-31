import { z } from 'zod/v4';

export const CAPABILITY_VALUES = [
  'job:create',
  'job:read',
  'job:decide',
  'qa:request',
  'work:report',
  'evidence:add',
  'artifact:register',
] as const;

export type Capability = (typeof CAPABILITY_VALUES)[number];

export const ActorRoleSchema = z.enum(['principal', 'worker', 'observer', 'system']);
export type ActorRole = z.infer<typeof ActorRoleSchema>;

const CapabilitySchema = z.enum(CAPABILITY_VALUES);
const CapabilityListSchema = z.array(CapabilitySchema).superRefine((values, context) => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      context.addIssue({
        code: 'custom',
        message: 'capabilities must not contain duplicates',
      });
    }
    seen.add(value);
  }
});

export class AuthorityConfigurationError extends Error {
  public override readonly name = 'AuthorityConfigurationError';
}

const ALLOWED_BY_ROLE: Readonly<Record<ActorRole, ReadonlySet<Capability>>> = {
  principal: new Set([
    'job:create',
    'job:read',
    'job:decide',
    'qa:request',
    'evidence:add',
    'artifact:register',
  ]),
  worker: new Set(['job:read', 'work:report', 'evidence:add', 'artifact:register']),
  observer: new Set(['job:read']),
  system: new Set(),
};

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new AuthorityConfigurationError('capabilities_json must contain valid JSON.');
  }
}

export function parseCapabilities(value: string): Capability[] {
  const parsed = CapabilityListSchema.safeParse(parseJson(value));
  if (!parsed.success) {
    throw new AuthorityConfigurationError(
      'capabilities_json must be a duplicate-free array of known capabilities.',
    );
  }
  return [...parsed.data];
}

export function canonicalCapabilitiesJson(capabilities: readonly Capability[]): string {
  return JSON.stringify([...capabilities].sort());
}

export function assertRoleCapabilities(
  role: ActorRole,
  capabilities: readonly Capability[],
): void {
  const allowed = ALLOWED_BY_ROLE[role];
  if (capabilities.some((capability) => !allowed.has(capability))) {
    throw new AuthorityConfigurationError(
      'The actor capability set is incompatible with its role.',
    );
  }
  if (role === 'principal' && !capabilities.includes('job:decide')) {
    throw new AuthorityConfigurationError('The principal must have job:decide.');
  }
  if (role === 'system' && capabilities.length !== 0) {
    throw new AuthorityConfigurationError('The system actor must have no public capabilities.');
  }
}

export function hasCapability(
  capabilities: readonly Capability[],
  capability: Capability,
): boolean {
  return capabilities.includes(capability);
}

export function allowedCapabilitiesForRole(role: ActorRole): readonly Capability[] {
  return [...ALLOWED_BY_ROLE[role]];
}
