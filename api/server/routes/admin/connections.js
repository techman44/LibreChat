const express = require('express');
const { createAdminConnectionsHandlers } = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { hasConfigCapability, requireCapability } = require('~/server/middleware/roles/capabilities');
const { invalidateConfigCaches } = require('~/server/services/Config');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);

const handlers = createAdminConnectionsHandlers({
  findConfigByPrincipal: db.findConfigByPrincipal,
  patchConfigFields: db.patchConfigFields,
  hasConfigCapability,
  invalidateConfigCaches,
});

router.use(requireJwtAuth, requireAdminAccess);

router.get('/', handlers.listConnections);
router.post('/', handlers.createConnection);
router.put('/:name', handlers.updateConnection);
router.delete('/:name', handlers.deleteConnection);

module.exports = router;
