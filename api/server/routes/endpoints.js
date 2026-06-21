const express = require('express');
const { probeEndpoint, extractBaseURL } = require('@librechat/api');
const { SystemCapabilities, logger } = require('@librechat/data-schemas');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const configMiddleware = require('~/server/middleware/config/app');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { connectionTestLimiter } = require('~/server/middleware/limiters');
const endpointController = require('~/server/controllers/EndpointController');
const tokenConfigController = require('~/server/controllers/TokenConfigController');
const contextProjectionController = require('~/server/controllers/ContextProjectionController');

const router = express.Router();
const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);

/** Auth required for role/tenant-scoped endpoint config resolution. */
router.get('/', requireJwtAuth, endpointController);
router.get('/token-config', requireJwtAuth, configMiddleware, tokenConfigController);
router.post('/context-projection', requireJwtAuth, configMiddleware, contextProjectionController);

/**
 * Admin: live connection test against an OpenAI-compatible endpoint. Issues a
 * `/models` probe (plus an optional 1-token chat ping) and returns reachability
 * diagnostics. Admin-gated and rate-limited; never persists the supplied key.
 */
router.post(
  '/connections/test',
  requireJwtAuth,
  requireAdminAccess,
  connectionTestLimiter,
  async (req, res) => {
    const { baseURL, apiKey, name, headers, chatPing, useResponsesApi } = req.body ?? {};

    if (typeof baseURL !== 'string' || !baseURL.trim()) {
      return res.status(400).json({ message: 'A valid baseURL is required' });
    }

    const resolvedBaseURL = extractBaseURL(baseURL.trim());
    if (!resolvedBaseURL) {
      return res.status(400).json({ message: 'Invalid baseURL' });
    }

    let parsed;
    try {
      parsed = new URL(resolvedBaseURL);
    } catch {
      return res.status(400).json({ message: 'Invalid baseURL' });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return res.status(400).json({ message: 'baseURL must use http or https' });
    }

    try {
      const result = await probeEndpoint({
        apiKey: typeof apiKey === 'string' ? apiKey : '',
        baseURL: resolvedBaseURL,
        name: typeof name === 'string' ? name : undefined,
        headers: headers && typeof headers === 'object' ? headers : undefined,
        userObject: req.user,
        chatPing: chatPing === true,
        useResponsesApi: useResponsesApi === true,
      });
      return res.status(200).json(result);
    } catch (error) {
      logger.error('[POST /endpoints/connections/test] Probe failed:', error);
      return res.status(500).json({ message: 'Connection test failed' });
    }
  },
);

module.exports = router;
