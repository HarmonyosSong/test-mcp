/** Server-owned identity types used by auth and business routes. */

export interface UserIdentity {
  subject: string;
  displayName: string;
  issuer: string;
}

const WORKCODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function employeeIdentity(
  workcode: string,
  displayName = '',
  issuer = 'sso',
): UserIdentity {
  if (typeof workcode !== 'string' || !WORKCODE_PATTERN.test(workcode)) {
    throw new Error('Trusted employee workcode must be a nonempty string');
  }
  return {
    subject: workcode,
    displayName: displayName || workcode,
    issuer,
  };
}
