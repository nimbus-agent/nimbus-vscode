/** One credential field to prompt for. `secret` fields use a masked input box. */
export type AuthField = {
  name: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
};

const PAT = (label: string, name = "personalAccessToken"): AuthField => ({
  name,
  label,
  secret: true,
  required: true,
});

const ATLASSIAN_FIELDS: readonly AuthField[] = [
  { name: "atlassianEmail", label: "Atlassian account email", secret: false, required: true },
  {
    name: "apiBaseUrl",
    label: "Atlassian site URL",
    secret: false,
    required: true,
    placeholder: "https://your-team.atlassian.net",
  },
  { name: "token", label: "Atlassian API token", secret: true, required: true },
];

/**
 * Every field name below is taken from the pinned client's JSDoc for
 * ConnectorAuthParams. The Gateway owns the real list and can out-run this one;
 * an unknown serviceId falls back to GENERIC_FIELD rather than failing, and a
 * rejected call reports the Gateway's own message, which names the field it
 * wanted. See docs/connectors.md.
 *
 * An empty array means "call with serviceId alone" — the OAuth (PKCE) shape,
 * where the Gateway opens a browser and listens on a local port.
 */
const AUTH_CATALOG: Record<string, readonly AuthField[]> = {
  github: [PAT("GitHub personal access token")],
  gitlab: [PAT("GitLab personal access token")],
  bitbucket: [PAT("Bitbucket app password")],
  jira: ATLASSIAN_FIELDS,
  confluence: ATLASSIAN_FIELDS,
  // AWS is deliberately absent: the client's JSDoc names awsAccessKeyId but not its secret
  // counterpart. This extension may not read the Gateway to discover it, so AWS uses the
  // generic flow (GENERIC_FIELD plus "add another field" loop) until a client release documents the pair.
  azure: [
    { name: "azureTenantId", label: "Azure tenant id", secret: false, required: true },
    { name: "token", label: "Azure access token", secret: true, required: true },
  ],
  gcp: [
    {
      name: "gcpCredentialsJsonPath",
      label: "Path to the GCP credentials JSON",
      secret: false,
      required: true,
    },
  ],
  google_drive: [],
  slack: [PAT("Slack token", "token")],
};

/** What an unrecognised connector is asked for. Masked: assume it is a secret. */
export const GENERIC_FIELD: AuthField = {
  name: "token",
  label: "Credential",
  secret: true,
  required: true,
};

export function isKnownProvider(serviceId: string): boolean {
  return serviceId in AUTH_CATALOG;
}

export function authFieldsFor(serviceId: string): readonly AuthField[] {
  return AUTH_CATALOG[serviceId] ?? [GENERIC_FIELD];
}
