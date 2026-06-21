import { logger, BASE_CONFIG_PRINCIPAL_ID, encryptV3 } from '@librechat/data-schemas';
import { PrincipalType, PrincipalModel, EModelEndpoint } from 'librechat-data-provider';
import type { IConfig, ConfigSection, SystemCapability } from '@librechat/data-schemas';
import type { TCustomConfig, TEndpoint } from 'librechat-data-provider';
import type { Types, ClientSession } from 'mongoose';
import type { Response } from 'express';
import type { CapabilityUser } from '~/middleware/capabilities';
import type { ServerRequest } from '~/types/http';

const DEFAULT_PRIORITY = 10;
const ENCRYPTED_PREFIX = 'v3:';
const MASKED_API_KEY = '__MASKED__';
const ENDPOINTS_CUSTOM_PATH = 'endpoints.custom';

/** Reserved provider names that collide with built-in endpoints. */
const RESERVED_NAMES = new Set<string>(Object.values(EModelEndpoint).map((v) => v.toLowerCase()));

type CustomEndpoint = Partial<TEndpoint> & { name: string };
/** A connection coming from request validation always has name/baseURL/apiKey. */
type ValidatedConnection = CustomEndpoint & { baseURL: string; apiKey: string };

export interface AdminConnectionsDeps {
  findConfigByPrincipal: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    options?: { includeInactive?: boolean },
    session?: ClientSession,
  ) => Promise<IConfig | null>;
  patchConfigFields: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    principalModel: PrincipalModel,
    fields: Record<string, unknown>,
    priority: number,
    session?: ClientSession,
  ) => Promise<IConfig | null>;
  hasConfigCapability: (
    user: CapabilityUser,
    section: ConfigSection | null,
    verb?: 'manage' | 'read',
  ) => Promise<boolean>;
  /** Invalidate all config-related caches after a mutation. */
  invalidateConfigCaches?: (tenantId?: string) => Promise<void>;
}

function getCapabilityUser(req: ServerRequest): CapabilityUser | null {
  if (!req.user) {
    return null;
  }
  return {
    id: req.user.id ?? req.user._id?.toString() ?? '',
    role: req.user.role ?? '',
    tenantId: (req.user as { tenantId?: string }).tenantId,
  };
}

function readCustomEndpoints(config: IConfig | null): CustomEndpoint[] {
  const custom = (config?.overrides as Partial<TCustomConfig> | undefined)?.endpoints?.custom;
  if (!Array.isArray(custom)) {
    return [];
  }
  return custom.filter(
    (entry): entry is CustomEndpoint =>
      entry != null && typeof entry === 'object' && typeof entry.name === 'string',
  );
}

/** Hide secret material before returning a connection to the client. */
function maskEndpoint(endpoint: CustomEndpoint): CustomEndpoint {
  if (endpoint.apiKey == null) {
    return endpoint;
  }
  return { ...endpoint, apiKey: MASKED_API_KEY };
}

function isEnvOrUserProvided(apiKey: string): boolean {
  return apiKey === 'user_provided' || /^\$\{[\w]+\}$/.test(apiKey.trim());
}

/**
 * Encrypt a literal apiKey at rest. Env-var references (`${VAR}`) and
 * `user_provided` are passthrough placeholders and stored verbatim so the
 * existing request-time resolution path keeps working unchanged.
 */
function encryptApiKey(apiKey: string): string {
  if (apiKey.startsWith(ENCRYPTED_PREFIX) || isEnvOrUserProvided(apiKey)) {
    return apiKey;
  }
  return encryptV3(apiKey);
}

function validateConnectionBody(
  body: unknown,
): { error: string } | { value: ValidatedConnection } {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a connection object' };
  }
  const { name, baseURL, apiKey, models, iconURL, headers } = body as Record<string, unknown>;

  if (typeof name !== 'string' || name.trim().length === 0) {
    return { error: 'name is required' };
  }
  if (RESERVED_NAMES.has(name.trim().toLowerCase())) {
    return { error: `name "${name}" collides with a built-in endpoint` };
  }
  if (typeof baseURL !== 'string' || baseURL.trim().length === 0) {
    return { error: 'baseURL is required' };
  }
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    return { error: 'apiKey is required' };
  }

  const value: ValidatedConnection = { name: name.trim(), baseURL: baseURL.trim(), apiKey };

  if (models !== undefined) {
    if (models == null || typeof models !== 'object' || Array.isArray(models)) {
      return { error: 'models must be an object' };
    }
    const { fetch, default: defaultModels } = models as Record<string, unknown>;
    const modelsValue: NonNullable<CustomEndpoint['models']> = {
      default: Array.isArray(defaultModels) ? (defaultModels as string[]) : [],
    };
    if (fetch !== undefined) {
      if (typeof fetch !== 'boolean') {
        return { error: 'models.fetch must be a boolean' };
      }
      modelsValue.fetch = fetch;
    }
    value.models = modelsValue;
  }

  if (iconURL !== undefined) {
    if (typeof iconURL !== 'string') {
      return { error: 'iconURL must be a string' };
    }
    value.iconURL = iconURL;
  }

  if (headers !== undefined) {
    if (headers == null || typeof headers !== 'object' || Array.isArray(headers)) {
      return { error: 'headers must be an object' };
    }
    value.headers = headers as Record<string, string>;
  }

  return { value };
}

export function createAdminConnectionsHandlers(deps: AdminConnectionsDeps): {
  listConnections: (req: ServerRequest, res: Response) => Promise<Response>;
  createConnection: (req: ServerRequest, res: Response) => Promise<Response>;
  updateConnection: (req: ServerRequest, res: Response) => Promise<Response>;
  deleteConnection: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  const { findConfigByPrincipal, patchConfigFields, hasConfigCapability, invalidateConfigCaches } =
    deps;

  async function loadBaseConfig(): Promise<IConfig | null> {
    return findConfigByPrincipal(PrincipalType.ROLE, BASE_CONFIG_PRINCIPAL_ID, {
      includeInactive: true,
    });
  }

  async function persist(
    endpoints: CustomEndpoint[],
    existing: IConfig | null,
    tenantId?: string,
  ): Promise<IConfig | null> {
    const config = await patchConfigFields(
      PrincipalType.ROLE,
      BASE_CONFIG_PRINCIPAL_ID,
      PrincipalModel.ROLE,
      { [ENDPOINTS_CUSTOM_PATH]: endpoints },
      existing?.priority ?? DEFAULT_PRIORITY,
    );
    invalidateConfigCaches?.(tenantId)?.catch((err) =>
      logger.error('[adminConnections] Cache invalidation failed:', err),
    );
    return config;
  }

  /** GET / — list custom AI provider connections (apiKey masked). */
  async function listConnections(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const user = getCapabilityUser(req);
      if (!user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (!(await hasConfigCapability(user, 'endpoints' as ConfigSection, 'read'))) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      const config = await loadBaseConfig();
      const connections = readCustomEndpoints(config).map(maskEndpoint);
      return res.status(200).json({ connections });
    } catch (error) {
      logger.error('[adminConnections] listConnections error:', error);
      return res.status(500).json({ error: 'Failed to list connections' });
    }
  }

  /** POST / — create a new custom AI provider connection. */
  async function createConnection(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const user = getCapabilityUser(req);
      if (!user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (!(await hasConfigCapability(user, 'endpoints' as ConfigSection, 'manage'))) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      const result = validateConnectionBody(req.body);
      if ('error' in result) {
        return res.status(400).json({ error: result.error });
      }

      const existing = await loadBaseConfig();
      const endpoints = readCustomEndpoints(existing);
      const lowerName = result.value.name.toLowerCase();
      if (endpoints.some((e) => e.name.toLowerCase() === lowerName)) {
        return res.status(409).json({ error: `Connection "${result.value.name}" already exists` });
      }

      const stored: CustomEndpoint = {
        ...result.value,
        apiKey: encryptApiKey(result.value.apiKey),
      };
      const config = await persist([...endpoints, stored], existing, user.tenantId);
      return res.status(201).json({ connection: maskEndpoint(stored), config });
    } catch (error) {
      logger.error('[adminConnections] createConnection error:', error);
      return res.status(500).json({ error: 'Failed to create connection' });
    }
  }

  /** PUT /:name — replace an existing connection. */
  async function updateConnection(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const user = getCapabilityUser(req);
      if (!user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (!(await hasConfigCapability(user, 'endpoints' as ConfigSection, 'manage'))) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      const { name } = req.params as { name: string };
      const body = { ...(req.body as Record<string, unknown>), name };
      const result = validateConnectionBody(body);
      if ('error' in result) {
        return res.status(400).json({ error: result.error });
      }

      const existing = await loadBaseConfig();
      const endpoints = readCustomEndpoints(existing);
      const index = endpoints.findIndex((e) => e.name.toLowerCase() === name.toLowerCase());
      if (index === -1) {
        return res.status(404).json({ error: `Connection "${name}" not found` });
      }

      const current = endpoints[index];
      const apiKey =
        result.value.apiKey === MASKED_API_KEY
          ? (current.apiKey ?? '')
          : encryptApiKey(result.value.apiKey);
      const stored: CustomEndpoint = { ...result.value, apiKey };
      const updated = endpoints.map((e, i) => (i === index ? stored : e));

      const config = await persist(updated, existing, user.tenantId);
      return res.status(200).json({ connection: maskEndpoint(stored), config });
    } catch (error) {
      logger.error('[adminConnections] updateConnection error:', error);
      return res.status(500).json({ error: 'Failed to update connection' });
    }
  }

  /** DELETE /:name — remove a connection. */
  async function deleteConnection(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const user = getCapabilityUser(req);
      if (!user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (!(await hasConfigCapability(user, 'endpoints' as ConfigSection, 'manage'))) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      const { name } = req.params as { name: string };
      const existing = await loadBaseConfig();
      const endpoints = readCustomEndpoints(existing);
      const remaining = endpoints.filter((e) => e.name.toLowerCase() !== name.toLowerCase());
      if (remaining.length === endpoints.length) {
        return res.status(404).json({ error: `Connection "${name}" not found` });
      }

      await persist(remaining, existing, user.tenantId);
      return res.status(200).json({ success: true });
    } catch (error) {
      logger.error('[adminConnections] deleteConnection error:', error);
      return res.status(500).json({ error: 'Failed to delete connection' });
    }
  }

  return { listConnections, createConnection, updateConnection, deleteConnection };
}
