interface CeremonyIdentity {
  order: number;
  ownerKey: string | null;
}

const identities = new WeakMap<object, CeremonyIdentity>();
let nextOrder = 0;

export function identifyCeremony(
  content: object,
  ownerKey: string | null = null,
): CeremonyIdentity {
  const existing = identities.get(content);
  if (existing) return existing;
  const identity = { order: ++nextOrder, ownerKey };
  identities.set(content, identity);
  return identity;
}
