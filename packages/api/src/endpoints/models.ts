import axios from 'axios';
import crypto from 'crypto';
import { logger } from '@librechat/data-schemas';
import {
  Time,
  CacheKeys,
  KnownEndpoints,
  EModelEndpoint,
  defaultModels,
} from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { AxiosRequestConfig } from 'axios';
import {
  processModelData,
  extractBaseURL,
  isUserProvided,
  resolveHeaders,
  deriveBaseURL,
  logAxiosError,
  inputSchema,
  applyAxiosProxyConfig,
} from '~/utils';
import { getModelCacheTokenConfigKey, isScopedTokenConfigKey } from '~/endpoints/keys';
import { standardCache, tokenConfigCache } from '~/cache';

export interface FetchModelsParams {
  /** User ID for API requests */
  user?: string;
  /** API key for authentication */
  apiKey: string;
  /** Base URL for the API */
  baseURL?: string;
  /** Endpoint name (defaults to 'openAI') */
  name?: string;
  /** Whether directEndpoint was configured */
  direct?: boolean;
  /** Whether to fetch from Azure */
  azure?: boolean;
  /** Whether to send user ID as query parameter */
  userIdQuery?: boolean;
  /** Whether to create token configuration from API response */
  createTokenConfig?: boolean;
  /** Cache key for token configuration (uses name if omitted) */
  tokenKey?: string;
  /** Optional headers for the request */
  headers?: Record<string, string> | null;
  /** Optional user object for header resolution */
  userObject?: Partial<IUser>;
  /** Skip MODEL_QUERIES cache (e.g., for user-provided keys) */
  skipCache?: boolean;
}

/**
 * Fetches Ollama models from the specified base API path.
 * @param baseURL - The Ollama server URL
 * @param options - Optional configuration
 * @returns Promise resolving to array of model names
 */
async function fetchOllamaModels(
  baseURL: string,
  options: { headers?: Record<string, string> | null; user?: Partial<IUser> } = {},
): Promise<string[]> {
  if (!baseURL) {
    return [];
  }

  const ollamaEndpoint = deriveBaseURL(baseURL);

  const resolvedHeaders = resolveHeaders({
    headers: options.headers ?? undefined,
    user: options.user,
  });

  const response = await axios.get<{ models: Array<{ name: string }> }>(
    `${ollamaEndpoint}/api/tags`,
    {
      headers: resolvedHeaders,
      timeout: 5000,
    },
  );

  return response.data.models.map((tag) => tag.name);
}

async function backfillTokenConfigFromModelCache(
  cacheKey: string,
  tokenKey: string,
): Promise<boolean> {
  const cachedTokenConfig = await tokenConfigCache().get(getModelCacheTokenConfigKey(cacheKey));
  if (cachedTokenConfig == null) {
    return false;
  }

  await tokenConfigCache().set(tokenKey, cachedTokenConfig);
  return true;
}

/**
 * Splits a string by commas and trims each resulting value.
 * @param input - The input string to split.
 * @returns An array of trimmed values.
 */
export function splitAndTrim(input: string | null | undefined): string[] {
  if (!input || typeof input !== 'string') {
    return [];
  }
  return input
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Fetches models from the specified base API path or Azure, based on the provided configuration.
 *
 * @param params - The parameters for fetching the models.
 * @returns A promise that resolves to an array of model identifiers.
 */
export async function fetchModels({
  user,
  apiKey,
  baseURL: _baseURL,
  name = EModelEndpoint.openAI,
  direct = false,
  azure = false,
  userIdQuery = false,
  createTokenConfig = true,
  tokenKey,
  headers,
  userObject,
  skipCache = false,
}: FetchModelsParams): Promise<string[]> {
  let models: string[] = [];
  const baseURL = direct ? extractBaseURL(_baseURL ?? '') : _baseURL;

  if (!baseURL && !azure) {
    return models;
  }

  if (!apiKey) {
    return models;
  }

  // The MODEL_QUERIES cache is keyed by baseURL+apiKey only. That's safe
  // when the response is identical for every caller, but fails when callers
  // forward header templates that resolve to a user-bound value (e.g.
  // `Authorization: Bearer {{LIBRECHAT_OPENID_ID_TOKEN}}`): one user's
  // filtered list could otherwise be served to the next request that
  // shares the same baseURL+apiKey. Skip the cache whenever both `headers`
  // and `userObject` are supplied, since that's the signal the caller is
  // resolving headers against a specific user's identity.
  const hasUserScopedHeaders = !!headers && Object.keys(headers).length > 0 && !!userObject;
  const shouldCache = !skipCache && !(userIdQuery && user) && !hasUserScopedHeaders;
  const cacheKey = shouldCache ? modelsCacheKey(baseURL ?? '', apiKey) : '';
  const modelsCache = shouldCache ? standardCache(CacheKeys.MODEL_QUERIES) : null;
  if (modelsCache && cacheKey) {
    const cachedModels = await modelsCache.get(cacheKey);
    if (cachedModels) {
      if (createTokenConfig && tokenKey) {
        const tokenConfigBackfilled = await backfillTokenConfigFromModelCache(cacheKey, tokenKey);
        if (!tokenConfigBackfilled && isScopedTokenConfigKey(tokenKey)) {
          models = cachedModels as string[];
        } else {
          return cachedModels as string[];
        }
      } else {
        return cachedModels as string[];
      }
    }
  }

  if (name && name.toLowerCase().startsWith(KnownEndpoints.ollama)) {
    let ollamaModels: string[] | null = null;
    try {
      ollamaModels = await fetchOllamaModels(baseURL ?? '', { headers, user: userObject });
    } catch (ollamaError) {
      logAxiosError({
        message:
          'Failed to fetch models from Ollama API. Attempting to fetch via OpenAI-compatible endpoint.',
        error: ollamaError as Error,
      });
    }
    if (ollamaModels !== null) {
      if (modelsCache && cacheKey && ollamaModels.length > 0) {
        await modelsCache.set(cacheKey, ollamaModels, Time.TWO_MINUTES);
      }
      return ollamaModels;
    }
  }

  try {
    // Resolve template variables (e.g. {{LIBRECHAT_OPENID_ID_TOKEN}}) in the
    // configured headers, mirroring fetchOllamaModels above. Without this,
    // placeholder strings are forwarded literally on the model-fetch path.
    const resolvedHeaders = resolveHeaders({
      headers: headers ?? undefined,
      user: userObject,
    });

    const options: AxiosRequestConfig & {
      headers: Record<string, string>;
      timeout: number;
    } = {
      headers: {
        ...resolvedHeaders,
      },
      timeout: 5000,
    };

    if (name === EModelEndpoint.anthropic) {
      // Keep configured custom headers (e.g. gateway metadata) while the
      // provider-managed auth/version headers stay authoritative.
      options.headers = {
        ...resolvedHeaders,
        'x-api-key': apiKey,
        'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
      };
    } else {
      // Only fall back to the apiKey-based Bearer when the configured
      // headers did not already supply an Authorization. This lets
      // auth-aware proxies (e.g. LiteLLM with JWT auth) receive the user's
      // token on /v1/models so they can return a per-user filtered list.
      const hasAuthHeader = Object.keys(options.headers).some(
        (k) => k.toLowerCase() === 'authorization',
      );
      if (!hasAuthHeader) {
        options.headers.Authorization = `Bearer ${apiKey}`;
      }
    }

    if (process.env.OPENAI_ORGANIZATION && baseURL?.includes('openai')) {
      options.headers['OpenAI-Organization'] = process.env.OPENAI_ORGANIZATION;
    }

    const url = new URL(`${(baseURL ?? '').replace(/\/+$/, '')}${azure ? '' : '/models'}`);
    if (user && userIdQuery) {
      url.searchParams.append('user', user);
    }
    applyAxiosProxyConfig(options, url);
    const res = await axios.get(url.toString(), options);

    const input = res.data;

    const validationResult = inputSchema.safeParse(input);
    if (validationResult.success && createTokenConfig) {
      const endpointTokenConfig = processModelData(input);
      const cache = tokenConfigCache();
      await cache.set(tokenKey ?? name, endpointTokenConfig);
      if (modelsCache && cacheKey) {
        await cache.set(getModelCacheTokenConfigKey(cacheKey), endpointTokenConfig);
      }
    }
    models = input.data.map((item: { id: string }) => item.id);
  } catch (error) {
    const logMessage = `Failed to fetch models from ${azure ? 'Azure ' : ''}${name} API`;
    logAxiosError({ message: logMessage, error: error as Error });
  }

  if (modelsCache && cacheKey && models.length > 0) {
    await modelsCache.set(cacheKey, models, Time.TWO_MINUTES);
  }

  return models;
}

function modelsCacheKey(baseURL: string, apiKey: string): string {
  return crypto.createHash('sha256').update(`${baseURL}:${apiKey}`).digest('hex').slice(0, 32);
}

/**
 * Builds the request headers used to probe an OpenAI-compatible endpoint,
 * mirroring the auth/header resolution performed by {@link fetchModels}.
 */
function buildProbeHeaders({
  apiKey,
  name,
  baseURL,
  headers,
  userObject,
}: Pick<ProbeEndpointParams, 'apiKey' | 'name' | 'baseURL' | 'headers' | 'userObject'>): Record<
  string,
  string
> {
  const resolvedHeaders = resolveHeaders({
    headers: headers ?? undefined,
    user: userObject,
  });

  const requestHeaders: Record<string, string> = { ...resolvedHeaders };

  if (name === EModelEndpoint.anthropic) {
    requestHeaders['x-api-key'] = apiKey;
    requestHeaders['anthropic-version'] = process.env.ANTHROPIC_VERSION || '2023-06-01';
  } else {
    const hasAuthHeader = Object.keys(requestHeaders).some(
      (k) => k.toLowerCase() === 'authorization',
    );
    if (!hasAuthHeader) {
      requestHeaders.Authorization = `Bearer ${apiKey}`;
    }
  }

  if (process.env.OPENAI_ORGANIZATION && baseURL?.includes('openai')) {
    requestHeaders['OpenAI-Organization'] = process.env.OPENAI_ORGANIZATION;
  }

  return requestHeaders;
}

export interface ProbeEndpointParams {
  /** API key for authentication */
  apiKey: string;
  /** Base URL for the OpenAI-compatible API */
  baseURL: string;
  /** Endpoint name (defaults to 'openAI') */
  name?: string;
  /** Optional headers for the request */
  headers?: Record<string, string> | null;
  /** Optional user object for header placeholder resolution */
  userObject?: Partial<IUser>;
  /** Request timeout in milliseconds (defaults to 5000) */
  timeout?: number;
  /**
   * When true, also issue a 1-token chat-completions ping and, when the
   * endpoint opts into the Responses API, a matching `/responses` ping to
   * detect a backend that does not actually support it.
   */
  chatPing?: boolean;
  /** Whether the endpoint is configured to use the OpenAI Responses API */
  useResponsesApi?: boolean;
}

export interface ProbeEndpointResult {
  /** Whether the `/models` probe returned a successful response */
  reachable: boolean;
  /** Round-trip latency of the `/models` probe in milliseconds */
  latencyMs: number;
  /** Number of models returned by the probe (0 when unreachable) */
  modelCount: number;
  /**
   * True when the endpoint opts into the Responses API (`useResponsesApi`)
   * but a live `/responses` ping fails while chat-completions succeeds —
   * i.e. the backend only speaks chat/completions. Null when not probed.
   */
  detectedResponsesApiMismatch: boolean | null;
  /** HTTP status of the `/models` probe, when available */
  status?: number;
  /** Error message when the probe failed */
  error?: string;
}

/**
 * Performs a live reachability probe against an OpenAI-compatible endpoint by
 * issuing the same `/models` request used by {@link fetchModels}, measuring
 * latency and model count. Optionally issues a 1-token chat ping to detect a
 * Responses-API mismatch (endpoint opts into `useResponsesApi` but the backend
 * only supports chat/completions).
 */
export async function probeEndpoint({
  apiKey,
  baseURL,
  name = EModelEndpoint.openAI,
  headers,
  userObject,
  timeout = 5000,
  chatPing = false,
  useResponsesApi = false,
}: ProbeEndpointParams): Promise<ProbeEndpointResult> {
  const result: ProbeEndpointResult = {
    reachable: false,
    latencyMs: 0,
    modelCount: 0,
    detectedResponsesApiMismatch: null,
  };

  const requestHeaders = buildProbeHeaders({ apiKey, name, baseURL, headers, userObject });
  const url = new URL(`${baseURL.replace(/\/+$/, '')}/models`);
  const options: AxiosRequestConfig & { headers: Record<string, string>; timeout: number } = {
    headers: requestHeaders,
    timeout,
  };
  applyAxiosProxyConfig(options, url);

  const start = Date.now();
  try {
    const res = await axios.get(url.toString(), options);
    result.latencyMs = Date.now() - start;
    result.reachable = true;
    result.status = res.status;
    const data = res.data?.data;
    result.modelCount = Array.isArray(data) ? data.length : 0;
  } catch (error) {
    result.latencyMs = Date.now() - start;
    if (axios.isAxiosError(error) && error.response?.status) {
      result.status = error.response.status;
    }
    result.error = logAxiosError({
      message: `Connection probe failed for ${name} endpoint`,
      error: error as Error,
    });
    return result;
  }

  if (chatPing) {
    result.detectedResponsesApiMismatch = await detectResponsesApiMismatch({
      baseURL,
      headers: requestHeaders,
      timeout,
      useResponsesApi,
    });
  }

  return result;
}

/**
 * When the endpoint opts into the Responses API, pings `/responses` and
 * `/chat/completions` with a minimal 1-token payload. A mismatch is reported
 * when `/responses` fails (4xx/5xx/network) while `/chat/completions` succeeds,
 * indicating a backend (e.g. a chat-completions-only gateway) that cannot serve
 * the Responses API the endpoint is configured for.
 */
async function detectResponsesApiMismatch({
  baseURL,
  headers,
  timeout,
  useResponsesApi,
}: {
  baseURL: string;
  headers: Record<string, string>;
  timeout: number;
  useResponsesApi: boolean;
}): Promise<boolean | null> {
  if (!useResponsesApi) {
    return false;
  }

  const root = baseURL.replace(/\/+$/, '');
  const chatOk = await pingChatRoute(`${root}/chat/completions`, headers, timeout, {
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
  });
  const responsesOk = await pingChatRoute(`${root}/responses`, headers, timeout, {
    input: 'ping',
    max_output_tokens: 1,
  });

  if (chatOk && !responsesOk) {
    return true;
  }
  return false;
}

/**
 * Issues a minimal POST ping to a chat route and reports whether it was
 * accepted (any non-error HTTP status). The dummy `model` is intentionally
 * omitted-friendly: gateways that reject on the route itself (404/405) signal
 * lack of support, which is the signal the caller cares about.
 */
async function pingChatRoute(
  url: string,
  headers: Record<string, string>,
  timeout: number,
  body: Record<string, unknown>,
): Promise<boolean> {
  const options: AxiosRequestConfig & { headers: Record<string, string>; timeout: number } = {
    headers,
    timeout,
    validateStatus: () => true,
  };
  applyAxiosProxyConfig(options, new URL(url));
  try {
    const res = await axios.post(url, body, options);
    return res.status < 400;
  } catch {
    return false;
  }
}

/** Options for fetching OpenAI models */
export interface GetOpenAIModelsOptions {
  /** User ID for API requests */
  user?: string;
  /** Whether to fetch from Azure */
  azure?: boolean;
  /** Whether to fetch models for the Assistants endpoint */
  assistants?: boolean;
  /** OpenAI API key (if not using environment variable) */
  openAIApiKey?: string;
  /** Skip MODEL_QUERIES cache (e.g., for user-provided keys) */
  skipCache?: boolean;
  /** Configured custom headers forwarded to the (gateway-fronted) provider */
  headers?: Record<string, string> | null;
  /** User object for resolving header placeholders */
  userObject?: Partial<IUser>;
}

function resolveOpenAIApiKey(opts: GetOpenAIModelsOptions): string | undefined {
  return opts.openAIApiKey || process.env.OPENAI_API_KEY;
}

/**
 * Fetches models from OpenAI or Azure based on the provided options.
 * @param opts - Options for fetching models
 * @param _models - Fallback models array
 * @returns Promise resolving to array of model IDs
 */
export async function fetchOpenAIModels(
  opts: GetOpenAIModelsOptions,
  _models: string[] = [],
): Promise<string[]> {
  let models = _models.slice() ?? [];
  const apiKey = resolveOpenAIApiKey(opts);
  const openaiBaseURL = 'https://api.openai.com/v1';
  let baseURL = openaiBaseURL;
  let reverseProxyUrl = process.env.OPENAI_REVERSE_PROXY;

  if (opts.assistants && process.env.ASSISTANTS_BASE_URL) {
    reverseProxyUrl = process.env.ASSISTANTS_BASE_URL;
  } else if (opts.azure) {
    return models;
  }

  if (reverseProxyUrl) {
    baseURL = extractBaseURL(reverseProxyUrl) ?? openaiBaseURL;
  }

  if (baseURL || opts.azure) {
    models = await fetchModels({
      apiKey: apiKey ?? '',
      baseURL,
      azure: opts.azure,
      user: opts.user,
      name: EModelEndpoint.openAI,
      skipCache: opts.skipCache,
      headers: opts.headers,
      userObject: opts.userObject,
    });
  }

  if (models.length === 0) {
    return _models;
  }

  if (baseURL === openaiBaseURL) {
    const regex = /(text-davinci-003|gpt-|o\d+|chat-latest)/;
    const excludeRegex = /audio|realtime/;
    models = models.filter((model) => regex.test(model) && !excludeRegex.test(model));
    const instructModels = models.filter((model) => model.includes('instruct'));
    const otherModels = models.filter((model) => !model.includes('instruct'));
    models = otherModels.concat(instructModels);
  }

  return models;
}

/**
 * Loads the default models for OpenAI or Azure.
 * @param opts - Options for getting models
 * @returns Promise resolving to array of model IDs
 */
export async function getOpenAIModels(opts: GetOpenAIModelsOptions = {}): Promise<string[]> {
  let models = defaultModels[EModelEndpoint.openAI];

  if (opts.assistants) {
    models = defaultModels[EModelEndpoint.assistants];
  } else if (opts.azure) {
    models = defaultModels[EModelEndpoint.azureAssistants];
  }

  let key: string;
  if (opts.assistants) {
    key = 'ASSISTANTS_MODELS';
  } else if (opts.azure) {
    key = 'AZURE_OPENAI_MODELS';
  } else {
    key = 'OPENAI_MODELS';
  }

  if (process.env[key]) {
    return splitAndTrim(process.env[key]);
  }

  if (isUserProvided(resolveOpenAIApiKey(opts))) {
    return models;
  }

  return await fetchOpenAIModels(opts, models);
}

/**
 * Fetches models from the Anthropic API.
 * @param opts - Options for fetching models
 * @param _models - Fallback models array
 * @returns Promise resolving to array of model IDs
 */
export async function fetchAnthropicModels(
  opts: {
    user?: string;
    skipCache?: boolean;
    headers?: Record<string, string> | null;
    userObject?: Partial<IUser>;
  } = {},
  _models: string[] = [],
): Promise<string[]> {
  let models = _models.slice() ?? [];
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const anthropicBaseURL = 'https://api.anthropic.com/v1';
  let baseURL = anthropicBaseURL;
  const reverseProxyUrl = process.env.ANTHROPIC_REVERSE_PROXY;

  if (reverseProxyUrl) {
    baseURL = extractBaseURL(reverseProxyUrl) ?? anthropicBaseURL;
  }

  if (!apiKey) {
    return models;
  }

  if (baseURL) {
    models = await fetchModels({
      apiKey,
      baseURL,
      user: opts.user,
      name: EModelEndpoint.anthropic,
      tokenKey: EModelEndpoint.anthropic,
      skipCache: opts.skipCache,
      headers: opts.headers,
      userObject: opts.userObject,
    });
  }

  if (models.length === 0) {
    return _models;
  }

  return models;
}

/**
 * Gets Anthropic models from environment or API.
 * @param opts - Options for fetching models
 * @returns Promise resolving to array of model IDs
 */
export async function getAnthropicModels(
  opts: {
    user?: string;
    vertexModels?: string[];
    headers?: Record<string, string> | null;
    userObject?: Partial<IUser>;
  } = {},
): Promise<string[]> {
  const models = defaultModels[EModelEndpoint.anthropic];

  // Vertex AI models from YAML config take priority
  if (opts.vertexModels && opts.vertexModels.length > 0) {
    return opts.vertexModels;
  }

  if (process.env.ANTHROPIC_MODELS) {
    return splitAndTrim(process.env.ANTHROPIC_MODELS);
  }

  if (isUserProvided(process.env.ANTHROPIC_API_KEY)) {
    return models;
  }

  try {
    return await fetchAnthropicModels(opts, models);
  } catch (error) {
    logger.error('Error fetching Anthropic models:', error);
    return models;
  }
}

/**
 * Gets Google models from environment or defaults.
 * @returns Array of model IDs
 */
export function getGoogleModels(): string[] {
  let models = defaultModels[EModelEndpoint.google];
  if (process.env.GOOGLE_MODELS) {
    models = splitAndTrim(process.env.GOOGLE_MODELS);
  }
  return models;
}

/**
 * Gets Bedrock models from environment or defaults.
 * @returns Array of model IDs
 */
export function getBedrockModels(): string[] {
  let models = defaultModels[EModelEndpoint.bedrock];
  if (process.env.BEDROCK_AWS_MODELS) {
    models = splitAndTrim(process.env.BEDROCK_AWS_MODELS);
  }
  return models;
}
