import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';

process.env.CREDS_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.CREDS_IV = '0123456789abcdef0123456789abcdef';

/* eslint-disable @typescript-eslint/no-var-requires */
const { decryptV3 } = require('@librechat/data-schemas');
const { createAdminConnectionsHandlers } = require('./connections');
/* eslint-enable @typescript-eslint/no-var-requires */

function mockReq(overrides = {}) {
  return {
    user: { id: 'u1', role: 'ADMIN', _id: { toString: () => 'u1' } },
    params: {},
    body: {},
    query: {},
    ...overrides,
  } as Partial<ServerRequest> as ServerRequest;
}

interface MockRes {
  statusCode: number;
  body: undefined | { connection?: unknown; connections?: unknown; error?: string; success?: boolean };
  status: jest.Mock;
  json: jest.Mock;
}

function mockRes() {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((data: MockRes['body']) => {
      res.body = data;
      return res;
    }),
  };
  return res as Partial<Response> as Response & MockRes;
}

function createHandlers(overrides: Record<string, unknown> = {}) {
  const deps = {
    findConfigByPrincipal: jest.fn().mockResolvedValue(null),
    patchConfigFields: jest.fn().mockImplementation((_t, _i, _m, fields) => ({
      overrides: { endpoints: { custom: fields['endpoints.custom'] } },
      priority: 10,
      configVersion: 1,
    })),
    hasConfigCapability: jest.fn().mockResolvedValue(true),
    invalidateConfigCaches: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { handlers: createAdminConnectionsHandlers(deps as never), deps };
}

describe('createAdminConnectionsHandlers', () => {
  it('lists connections with apiKey masked', async () => {
    const { handlers } = createHandlers({
      findConfigByPrincipal: jest.fn().mockResolvedValue({
        overrides: {
          endpoints: { custom: [{ name: 'qwen', baseURL: 'https://x', apiKey: 'v3:abc' }] },
        },
      }),
    });
    const res = mockRes();
    await handlers.listConnections(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body?.connections).toEqual([
      { name: 'qwen', baseURL: 'https://x', apiKey: '__MASKED__' },
    ]);
  });

  it('encrypts a literal apiKey on create and persists it', async () => {
    const { handlers, deps } = createHandlers();
    const res = mockRes();
    await handlers.createConnection(
      mockReq({ body: { name: 'qwen', baseURL: 'https://x/v1', apiKey: 'sk-secret' } }),
      res,
    );
    expect(res.statusCode).toBe(201);
    const patch = (deps.patchConfigFields as jest.Mock).mock.calls[0][3];
    const stored = patch['endpoints.custom'][0];
    expect(stored.apiKey.startsWith('v3:')).toBe(true);
    expect(decryptV3(stored.apiKey)).toBe('sk-secret');
    expect(res.body?.connection).toMatchObject({ apiKey: '__MASKED__' });
  });

  it('stores env-var apiKey references verbatim', async () => {
    const { handlers, deps } = createHandlers();
    await handlers.createConnection(
      mockReq({ body: { name: 'qwen', baseURL: 'https://x/v1', apiKey: '${QWEN_KEY}' } }),
      mockRes(),
    );
    const stored = (deps.patchConfigFields as jest.Mock).mock.calls[0][3]['endpoints.custom'][0];
    expect(stored.apiKey).toBe('${QWEN_KEY}');
  });

  it('rejects names that collide with built-in endpoints', async () => {
    const { handlers } = createHandlers();
    const res = mockRes();
    await handlers.createConnection(
      mockReq({ body: { name: 'openAI', baseURL: 'https://x', apiKey: 'k' } }),
      res,
    );
    expect(res.statusCode).toBe(400);
  });

  it('rejects duplicate connection names', async () => {
    const { handlers } = createHandlers({
      findConfigByPrincipal: jest.fn().mockResolvedValue({
        overrides: { endpoints: { custom: [{ name: 'qwen', baseURL: 'https://x', apiKey: 'k' }] } },
      }),
    });
    const res = mockRes();
    await handlers.createConnection(
      mockReq({ body: { name: 'qwen', baseURL: 'https://y', apiKey: 'k2' } }),
      res,
    );
    expect(res.statusCode).toBe(409);
  });

  it('preserves the existing apiKey when update sends the masked sentinel', async () => {
    const { handlers, deps } = createHandlers({
      findConfigByPrincipal: jest.fn().mockResolvedValue({
        overrides: {
          endpoints: { custom: [{ name: 'qwen', baseURL: 'https://x', apiKey: 'v3:kept' }] },
        },
      }),
    });
    await handlers.updateConnection(
      mockReq({
        params: { name: 'qwen' },
        body: { baseURL: 'https://new', apiKey: '__MASKED__' },
      }),
      mockRes(),
    );
    const stored = (deps.patchConfigFields as jest.Mock).mock.calls[0][3]['endpoints.custom'][0];
    expect(stored.apiKey).toBe('v3:kept');
    expect(stored.baseURL).toBe('https://new');
  });

  it('returns 404 when deleting an unknown connection', async () => {
    const { handlers } = createHandlers();
    const res = mockRes();
    await handlers.deleteConnection(mockReq({ params: { name: 'nope' } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('enforces manage capability on create', async () => {
    const { handlers } = createHandlers({
      hasConfigCapability: jest.fn().mockResolvedValue(false),
    });
    const res = mockRes();
    await handlers.createConnection(
      mockReq({ body: { name: 'qwen', baseURL: 'https://x', apiKey: 'k' } }),
      res,
    );
    expect(res.statusCode).toBe(403);
  });
});
