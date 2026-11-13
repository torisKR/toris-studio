export type MobileInterface = { name: string; address: string };
export type MobileProject = { name: string };
export type MobileDevice = {
  id: string;
  name: string;
  fingerprint: string;
  lastConnected: string | null;
  projects: { id: string; name: string }[];
};
export type MobilePending = { id: string; name: string; fingerprint: string; confirmationCode: string };
export type MobileStatus = {
  available: boolean;
  enabled: boolean;
  interfaces: MobileInterface[];
  address: string | null;
  port: number | null;
  fingerprint: string | null;
  devices: MobileDevice[];
  pending: MobilePending | null;
  projects: MobileProject[];
};
export type MobileQr = { url: string; expiresAt: string | number };

export function isPrivateAddress(address: string): boolean {
  const parts = address.split(".");
  if (parts.length === 4 && parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) {
    const [a, b] = parts.map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return false;
}

export function expiryTime(value: string | number): number {
  if (typeof value === "number") return value < 1_000_000_000_000 ? value * 1000 : value;
  if (typeof value !== "string") return Number.NaN;
  if (/^\d+$/.test(value)) return expiryTime(Number(value));
  return Date.parse(value);
}

export function isQrImageUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  return /^toris-mobile:\/\/localhost\/qr\?v=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url);
}

export function projectChoices(projects: MobileProject[]): { names: string[]; ambiguous: boolean } {
  const counts = new Map<string, number>();
  for (const project of projects) {
    if (project.name.trim()) counts.set(project.name, (counts.get(project.name) ?? 0) + 1);
  }
  return {
    names: [...counts].filter(([, count]) => count === 1).map(([name]) => name),
    ambiguous: [...counts.values()].some(count => count > 1)
  };
}

export function permissionArgs(projects: MobileProject[], selected: string[], allowCreate: boolean | null) {
  const choices = new Set(projectChoices(projects).names);
  if (allowCreate === null || new Set(selected).size !== selected.length || selected.some(name => !choices.has(name))) return null;
  return { projects: selected, allowCreate };
}

export function approvalArgs(
  pending: MobilePending, projects: MobileProject[], selected: string[], allowCreate: boolean,
  fingerprintMatches: boolean, codeMatches: boolean
) {
  if (!fingerprintMatches || !codeMatches) return null;
  const permissions = permissionArgs(projects, selected, allowCreate);
  return permissions ? { attemptId: pending.id, ...permissions } : null;
}

// An issue already in flight must finish before the unmount/close invalidation,
// and a subsequent issue must not race that invalidation.
export class MobileQrQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
