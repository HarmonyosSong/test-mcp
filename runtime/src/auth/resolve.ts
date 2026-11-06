/** Shared input for IdentityProvider.resolve (SSO and local). */

export type ResolveIdentityInput = {
  method: string;
  origin: string | undefined;
  csrfHeader: string | undefined;
  sessionToken: string | undefined;
  clientHost?: string | null;
  requestHostname?: string | null;
};
