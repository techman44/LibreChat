import type { OpenAIClientOptions } from '@librechat/agents';
import { enforceResponsesApiPreference, RESPONSES_ONLY_KEYS } from '~/agents/run';

// Mock winston logger — `format` must be callable so @librechat/data-schemas
// dist module-load completes cleanly; see api/test/__mocks__/logger.js.
jest.mock('winston', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  })),
  format: Object.assign(
    jest.fn((fn) => () => ({ transform: fn })),
    {
      combine: jest.fn(),
      colorize: jest.fn(),
      simple: jest.fn(),
      label: jest.fn(),
      timestamp: jest.fn(),
      printf: jest.fn(),
      errors: jest.fn(),
      splat: jest.fn(),
      json: jest.fn(),
    },
  ),
  addColors: jest.fn(),
  transports: {
    Console: jest.fn(),
    DailyRotateFile: jest.fn(),
    File: jest.fn(),
  },
}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

// `@librechat/agents`'s real dist pulls in `@langchain/xai`, whose nested
// `@langchain/openai` build fails to resolve in this jest env. `run.ts` only
// needs `Run`/`Providers`/`Constants` as values, none of which this pure-helper
// test exercises — so stub the module to avoid loading the broken chain.
jest.mock('@librechat/agents', () => ({
  Run: { create: jest.fn() },
  Providers: {},
  Constants: {},
}));

/**
 * Regression lock for the Responses-API hardening: a chat/completions-only
 * backend (e.g. LiteLLM serving local Qwen) must never receive Responses-only
 * fields whose mere presence makes `@langchain/openai` promote the request to
 * the Responses API. The shared `enforceResponsesApiPreference` guards the
 * agent run, summarization, and memory code paths identically.
 *
 * The Responses-only keys are not all named members of `ChatOpenAIFields`, so —
 * exactly as `run.ts`/`memory.ts` do — configs are assembled through a
 * `Record<string, unknown>` bag before being handed to the helper.
 */
describe('enforceResponsesApiPreference', () => {
  const buildConfig = (
    extra: Record<string, unknown> = {},
  ): Partial<OpenAIClientOptions> => {
    const config: Record<string, unknown> = {
      reasoning: { effort: 'medium' },
      text: { verbosity: 'low' },
      truncation: 'auto',
      include: ['reasoning.encrypted_content'],
      previous_response_id: 'resp_123',
      ...extra,
    };
    return config as Partial<OpenAIClientOptions>;
  };

  it('strips every Responses-only key when useResponsesApi is undefined', () => {
    const config = buildConfig({ model: 'qwen', temperature: 0.5 });

    enforceResponsesApiPreference(config);

    const bag = config as Record<string, unknown>;
    for (const key of RESPONSES_ONLY_KEYS) {
      expect(key in bag).toBe(false);
    }
    // Chat/completions-safe fields are untouched.
    expect(bag.model).toBe('qwen');
    expect(bag.temperature).toBe(0.5);
  });

  it('strips every Responses-only key when useResponsesApi is false', () => {
    const config = buildConfig({ useResponsesApi: false });

    enforceResponsesApiPreference(config);

    const bag = config as Record<string, unknown>;
    for (const key of RESPONSES_ONLY_KEYS) {
      expect(key in bag).toBe(false);
    }
    expect(config.useResponsesApi).toBe(false);
  });

  it('preserves every Responses-only key when useResponsesApi is true', () => {
    const config = buildConfig({ useResponsesApi: true });

    enforceResponsesApiPreference(config);

    const bag = config as Record<string, unknown>;
    expect(bag.reasoning).toEqual({ effort: 'medium' });
    expect(bag.text).toEqual({ verbosity: 'low' });
    expect(bag.truncation).toBe('auto');
    expect(bag.include).toEqual(['reasoning.encrypted_content']);
    expect(bag.previous_response_id).toBe('resp_123');
    expect(config.useResponsesApi).toBe(true);
  });

  it('only removes keys that are actually present', () => {
    const config = { model: 'qwen', reasoning: { effort: 'high' } } as Partial<OpenAIClientOptions>;

    enforceResponsesApiPreference(config);

    const bag = config as Record<string, unknown>;
    expect('reasoning' in bag).toBe(false);
    expect('text' in bag).toBe(false);
    expect(bag.model).toBe('qwen');
  });

  it('is a no-op for a config that carries no Responses-only keys', () => {
    const config = {
      model: 'qwen',
      temperature: 0.7,
      maxTokens: 1024,
    } as Partial<OpenAIClientOptions>;

    enforceResponsesApiPreference(config);

    expect(config).toEqual({ model: 'qwen', temperature: 0.7, maxTokens: 1024 });
  });
});
