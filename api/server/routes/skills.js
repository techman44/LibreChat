const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const multer = require('multer');
const express = require('express');
const {
  createSkillsHandlers,
  createImportHandler,
  generateCheckAccess,
  getStorageMetadata,
  buildDeploymentSkill,
  reloadDeploymentSkills,
  resolveRequestTenantId,
  validateSkillMarkdown,
  restoreTenantContextFromReq,
} = require('@librechat/api');
const { isValidObjectIdString, SystemCapabilities, logger } = require('@librechat/data-schemas');
const {
  PermissionBits,
  PermissionTypes,
  Permissions,
  FileContext,
  mergeFileConfig,
} = require('librechat-data-provider');
const {
  createSkill,
  getSkillById,
  updateSkill,
  deleteSkill,
  upsertSkillFile,
  deleteSkillFile,
  getSkillFileByPath,
  getRoleByName,
} = require('~/models');
const { requireJwtAuth, canAccessSkillResource } = require('~/server/middleware');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const {
  findAccessibleResources,
  findPubliclyAccessibleResources,
  hasPublicPermission,
  grantPermission,
} = require('~/server/services/PermissionService');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { createFileLimiters } = require('~/server/middleware/limiters/uploadLimiters');
const { maybeRunGitHubSkillSyncForRequest } = require('~/server/services/Skills/sync');
const configMiddleware = require('~/server/middleware/config/app');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const {
  getSkillDbMethods,
  withDeploymentSkillIds,
  getSkillStrategyFunctions,
} = require('~/server/services/Endpoints/agents/skillDeps');

const router = express.Router();

// ---------------------------------------------------------------------------
// Multer: memory storage for skill imports (zip processed in-memory)
// ---------------------------------------------------------------------------
const ALLOWED_EXTENSIONS = new Set(['.md', '.zip', '.skill']);
const MAX_IMPORT_SIZE = 50 * 1024 * 1024; // 50 MB

const memoryStorage = multer.memoryStorage();

function getSkillImportSizeLimit(req) {
  const fileConfig = mergeFileConfig(req.config?.fileConfig);
  return fileConfig.skills?.fileSizeLimit ?? MAX_IMPORT_SIZE;
}

const skillImportFilter = (_req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_EXTENSIONS.has(ext)) {
    cb(null, true);
  } else {
    // N.B. The error handler at the bottom of this file matches this "Only " prefix.
    cb(new Error('Only .md, .zip, and .skill files are allowed'), false);
  }
};

const skillUpload = (req, res, next) =>
  multer({
    storage: memoryStorage,
    fileFilter: skillImportFilter,
    limits: { fileSize: getSkillImportSizeLimit(req) },
  }).single('file')(req, res, next);

// Per-file upload (for adding individual files to an existing skill)
const MAX_SINGLE_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const singleFileUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: MAX_SINGLE_FILE_SIZE },
});

// ---------------------------------------------------------------------------
// Role-based capability gates
// ---------------------------------------------------------------------------
const checkSkillAccess = generateCheckAccess({
  permissionType: PermissionTypes.SKILLS,
  permissions: [Permissions.USE],
  getRoleByName,
});
const checkSkillCreate = generateCheckAccess({
  permissionType: PermissionTypes.SKILLS,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName,
});
const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);

// ---------------------------------------------------------------------------
// Rate limiters (reuse existing file upload limiters)
// ---------------------------------------------------------------------------
const { fileUploadIpLimiter, fileUploadUserLimiter } = createFileLimiters();
const skillDbMethods = getSkillDbMethods();

router.use(requireJwtAuth);
router.use(configMiddleware);
router.use(checkSkillAccess);

// ---------------------------------------------------------------------------
// CRUD handlers
// ---------------------------------------------------------------------------
const handlers = createSkillsHandlers({
  createSkill,
  getSkillById: skillDbMethods.getSkillById,
  listSkillsByAccess: skillDbMethods.listSkillsByAccess,
  updateSkill,
  deleteSkill,
  listSkillFiles: skillDbMethods.listSkillFiles,
  deleteSkillFile,
  getSkillFileByPath: skillDbMethods.getSkillFileByPath,
  updateSkillFileContent: skillDbMethods.updateSkillFileContent,
  getStrategyFunctions: getSkillStrategyFunctions,
  findAccessibleResources: async (params) =>
    params.resourceType === 'skill' && params.requiredPermissions === PermissionBits.VIEW
      ? withDeploymentSkillIds(await findAccessibleResources(params))
      : findAccessibleResources(params),
  findPubliclyAccessibleResources: async (params) =>
    params.resourceType === 'skill' && params.requiredPermissions === PermissionBits.VIEW
      ? withDeploymentSkillIds(await findPubliclyAccessibleResources(params))
      : findPubliclyAccessibleResources(params),
  hasPublicPermission: async (params) =>
    params.resourceType === 'skill' && params.requiredPermissions === PermissionBits.VIEW
      ? withDeploymentSkillIds([]).some((id) => id.toString() === params.resourceId.toString()) ||
        hasPublicPermission(params)
      : hasPublicPermission(params),
  grantPermission,
  isValidObjectIdString,
});

// ---------------------------------------------------------------------------
// File storage helper: resolve the active strategy's saveBuffer
// ---------------------------------------------------------------------------
function resolveSkillStorage(req, { isImage = false } = {}) {
  const source = getFileStrategy(req.config, { context: FileContext.skill_file, isImage });
  const strategy = getStrategyFunctions(source);
  if (!strategy.saveBuffer) {
    throw new Error(`Storage backend "${source}" does not support file writes`);
  }
  return { saveBuffer: strategy.saveBuffer, source };
}

// ---------------------------------------------------------------------------
// Import handler (zip/md/skill → create skill + files)
// ---------------------------------------------------------------------------
const importHandler = createImportHandler({
  limits: (req) => ({
    maxZipBytes: getSkillImportSizeLimit(req),
  }),
  createSkill,
  getSkillById,
  deleteSkill,
  upsertSkillFile,
  saveBuffer: (req, { userId, buffer, fileName, basePath, isImage, tenantId }) => {
    const requestTenantId = tenantId ?? resolveRequestTenantId(req);
    const storage = resolveSkillStorage(req, { isImage });
    return storage
      .saveBuffer({ userId, buffer, fileName, basePath, tenantId: requestTenantId })
      .then((filepath) => ({
        filepath,
        source: storage.source,
        ...getStorageMetadata({ filepath, source: storage.source }),
      }));
  },
  deleteFile: (req, file) => {
    const { deleteFile } = getStrategyFunctions(file.source);
    if (deleteFile) {
      return deleteFile(req, file);
    }
    return Promise.resolve();
  },
  grantPermission,
});

// ---------------------------------------------------------------------------
// Per-file upload handler (add a single file to an existing skill)
// ---------------------------------------------------------------------------
async function uploadFileHandler(req, res) {
  try {
    const { file } = req;
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const skillId = req.params.id;
    const relativePath = req.body.relativePath;
    if (!relativePath) {
      return res.status(400).json({ error: 'relativePath is required in form body' });
    }
    if (relativePath.toUpperCase() === 'SKILL.MD') {
      return res.status(400).json({ error: 'SKILL.md is reserved; update the skill body instead' });
    }
    // Reject traversal, absolute paths, empty/dot segments — matches model-layer validator
    // so storage writes don't happen before DB rejects the path.
    if (
      !/^[a-zA-Z0-9._\-/]+$/.test(relativePath) ||
      /^\//.test(relativePath) ||
      relativePath.split('/').some((s) => s === '' || s === '.' || s === '..')
    ) {
      return res.status(400).json({ error: 'Invalid file path' });
    }

    const tenantId = resolveRequestTenantId(req);

    // Look up existing file before saving — needed to clean up old blob on replace
    const existingFile = await getSkillFileByPath(skillId, relativePath);

    const fileId = crypto.randomUUID();
    const filename = file.originalname;
    const storageFileName = `${fileId}__${filename}`;

    const isImage = (file.mimetype || '').startsWith('image/');
    const storage = resolveSkillStorage(req, { isImage });
    const filepath = await storage.saveBuffer({
      userId: req.user.id,
      buffer: file.buffer,
      fileName: storageFileName,
      basePath: 'uploads',
      tenantId,
    });
    const storageMetadata = getStorageMetadata({ filepath, source: storage.source });

    let result;
    try {
      result = await upsertSkillFile({
        skillId,
        relativePath,
        file_id: fileId,
        filename,
        filepath,
        ...storageMetadata,
        source: storage.source,
        mimeType: file.mimetype || 'application/octet-stream',
        bytes: file.size,
        isExecutable: false,
        author: req.user._id,
        tenantId,
      });
    } catch (dbError) {
      // Clean up the stored blob so it doesn't leak on DB failure
      try {
        const { deleteFile } = getStrategyFunctions(storage.source);
        if (deleteFile) {
          await deleteFile(req, { filepath, user: req.user.id, tenantId });
        }
      } catch (cleanupErr) {
        logger.error('[uploadFile] Failed to clean up orphaned blob:', cleanupErr);
      }
      throw dbError;
    }

    // Clean up old blob if this was a replace (different filepath means new storage object)
    if (existingFile && existingFile.filepath !== filepath) {
      const { deleteFile: delOld } = getStrategyFunctions(existingFile.source);
      if (delOld) {
        delOld(req, {
          filepath: existingFile.filepath,
          user: existingFile.author ?? req.user.id,
          tenantId: existingFile.tenantId ?? tenantId,
        }).catch((e) => logger.error('[uploadFile] Old blob cleanup failed:', e));
      }
    }

    return res.status(200).json(result);
  } catch (error) {
    if (error.code === 'SKILL_FILE_VALIDATION_FAILED') {
      return res.status(400).json({ error: error.message });
    }
    logger.error('[uploadFile] Error:', error);
    return res.status(500).json({ error: 'Failed to upload file' });
  }
}

// ---------------------------------------------------------------------------
// Export handler (skill → .skill zip; inverse of import)
// ---------------------------------------------------------------------------
const SKILL_MD = 'SKILL.md';

/** Read a stored skill file blob into a Buffer via its storage strategy. */
async function readSkillFileBuffer(req, file) {
  const { getDownloadStream } = getStrategyFunctions(file.source);
  if (!getDownloadStream) {
    throw new Error(`Storage backend "${file.source}" does not support reads`);
  }
  const stream = await getDownloadStream(req, file.storageKey || file.filepath);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Build a filesystem-safe archive name from the skill name. */
function exportFilename(name) {
  const safe = (name || 'skill')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${safe || 'skill'}.skill`;
}

async function exportSkillHandler(req, res) {
  try {
    const skillId = req.params.id;
    const skill = await skillDbMethods.getSkillById(skillId);
    if (!skill) {
      return res.status(404).json({ error: 'Skill not found' });
    }

    const zip = new JSZip();
    zip.file(SKILL_MD, skill.body ?? '');

    const files = await skillDbMethods.listSkillFiles(skillId);
    for (const file of files) {
      if (file.relativePath.toUpperCase() === SKILL_MD.toUpperCase()) {
        continue;
      }
      const buffer = await readSkillFileBuffer(req, file);
      zip.file(file.relativePath, buffer);
    }

    const archive = await zip.generateAsync({ type: 'nodebuffer' });
    const filename = exportFilename(skill.name);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', archive.length);
    return res.status(200).send(archive);
  } catch (error) {
    logger.error('[GET /skills/:id/export] Error exporting skill', error);
    return res.status(500).json({ error: 'Failed to export skill' });
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
async function maybeStartRequestSkillSync(req, _res, next) {
  try {
    await maybeRunGitHubSkillSyncForRequest(req);
  } catch (error) {
    logger.error('[GET /skills] Failed to start request-scoped skill sync:', error);
  }
  next();
}

// Import: accepts .md / .zip / .skill via multipart
router.post(
  '/import',
  checkSkillCreate,
  fileUploadIpLimiter,
  fileUploadUserLimiter,
  skillUpload,
  restoreTenantContextFromReq,
  importHandler,
);

// Admin: hot-reload deployment (filesystem) skills without a process restart.
// A failed reload preserves the previously loaded registry; report it as 422.
router.post('/reload', requireAdminAccess, async (_req, res) => {
  try {
    const result = await reloadDeploymentSkills();
    return res.status(200).json(result);
  } catch (error) {
    logger.error('[POST /skills/reload] Deployment skill reload failed:', error);
    return res.status(422).json({ error: error.message || 'Failed to reload deployment skills' });
  }
});

// AI Skill Builder: validate a drafted SKILL.md without persisting. Used by the
// builder side panel to preview blocking errors / warnings before committing.
router.post('/builder/validate', checkSkillCreate, (req, res) => {
  const content = req.body?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({ error: 'A non-empty SKILL.md content string is required' });
  }
  try {
    return res.status(200).json(validateSkillMarkdown(content));
  } catch (error) {
    logger.error('[POST /skills/builder/validate] Validation failed:', error);
    return res.status(500).json({ error: 'Failed to validate SKILL.md' });
  }
});

// AI Skill Builder: persist a drafted SKILL.md to the deployment skills
// directory and hot-reload so it goes live without a restart. Admin-gated like
// /reload since it writes to the deployment filesystem. A validation failure is
// 400; a reload failure (duplicate name, malformed sibling) is 422.
router.post('/builder', requireAdminAccess, async (req, res) => {
  const content = req.body?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({ error: 'A non-empty SKILL.md content string is required' });
  }
  try {
    const result = await buildDeploymentSkill(content);
    return res.status(201).json(result);
  } catch (error) {
    if (error.code === 'SKILL_VALIDATION_FAILED') {
      return res.status(400).json({ error: error.message, issues: error.issues });
    }
    logger.error('[POST /skills/builder] Failed to build deployment skill:', error);
    return res.status(422).json({ error: error.message || 'Failed to build deployment skill' });
  }
});

router.get('/', maybeStartRequestSkillSync, handlers.list);
router.post('/', checkSkillCreate, handlers.create);

router.get(
  '/:id',
  canAccessSkillResource({ requiredPermission: PermissionBits.VIEW }),
  handlers.get,
);

router.patch(
  '/:id',
  checkSkillCreate,
  canAccessSkillResource({ requiredPermission: PermissionBits.EDIT }),
  handlers.patch,
);

router.delete(
  '/:id',
  checkSkillCreate,
  canAccessSkillResource({ requiredPermission: PermissionBits.DELETE }),
  handlers.delete,
);

// Export: stream the skill as a .skill zip (SKILL.md + bundled files). Admin-gated.
router.get(
  '/:id/export',
  requireAdminAccess,
  canAccessSkillResource({ requiredPermission: PermissionBits.VIEW }),
  restoreTenantContextFromReq,
  exportSkillHandler,
);

router.get(
  '/:id/files',
  canAccessSkillResource({ requiredPermission: PermissionBits.VIEW }),
  handlers.listFiles,
);

// Per-file upload (live — replaces 501 stub)
router.post(
  '/:id/files',
  canAccessSkillResource({ requiredPermission: PermissionBits.EDIT }),
  fileUploadIpLimiter,
  fileUploadUserLimiter,
  singleFileUpload.single('file'),
  restoreTenantContextFromReq,
  uploadFileHandler,
);

router.get(
  '/:id/files/:relativePath',
  canAccessSkillResource({ requiredPermission: PermissionBits.VIEW }),
  handlers.downloadFile,
);

router.delete(
  '/:id/files/:relativePath',
  canAccessSkillResource({ requiredPermission: PermissionBits.EDIT }),
  handlers.deleteFile,
);

// Multer + file-filter error handler — surface as 400, forward everything else

router.use((err, _req, res, next) => {
  if (err && (err.name === 'MulterError' || err.message?.startsWith('Only '))) {
    return res.status(400).json({ error: err.message });
  }
  return next(err);
});

module.exports = router;
