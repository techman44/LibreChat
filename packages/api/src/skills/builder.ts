import fs from 'fs';
import path from 'path';
import {
  partitionIssues,
  validateSkillName,
  validateSkillBody,
  validateSkillFrontmatter,
  validateSkillDescription,
} from '@librechat/data-schemas';
import type { ValidationIssue } from '@librechat/data-schemas';
import { parseSkillMarkdown } from './parse';
import {
  reloadDeploymentSkills,
  resolveDeploymentSkillDirectory,
  getDeploymentSkillRegistry,
} from './deployment';
import type { DeploymentSkillReloadResult } from './deployment';

export type SkillBuilderValidation = {
  valid: boolean;
  name: string;
  description: string;
  alwaysApply?: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
};

export type SkillBuilderWriteResult = {
  name: string;
  directory: string;
  relativeDirectory: string;
  reload: DeploymentSkillReloadResult;
};

/**
 * Derive a filesystem-safe directory slug from a skill name. Deployment skill
 * names already match {@link validateSkillName} (lowercase, alphanumeric +
 * hyphen), so this only guards against unexpected separators reaching the
 * filesystem.
 */
function toSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Validate a raw `SKILL.md` document using the same rules applied when
 * deployment skills are loaded from disk, without writing anything. Lets the
 * builder panel preview blocking errors and warnings before persisting.
 */
export function validateSkillMarkdown(raw: string): SkillBuilderValidation {
  const parsed = parseSkillMarkdown(raw);
  const frontmatter = parsed.frontmatter ?? {};
  const issues: ValidationIssue[] = [];
  if (parsed.parseError) {
    issues.push({
      field: 'frontmatter',
      code: 'INVALID_YAML',
      message: parsed.parseError,
    });
  }
  issues.push(
    ...validateSkillName(parsed.name),
    ...validateSkillDescription(parsed.description),
    ...validateSkillBody(raw),
    ...validateSkillFrontmatter(frontmatter),
  );
  for (const key of parsed.invalidBooleans) {
    issues.push({
      field: `frontmatter.${key}`,
      code: 'INVALID_TYPE',
      message: `"${key}" must be a boolean (true or false)`,
    });
  }
  const { errors, warnings } = partitionIssues(issues);
  return {
    valid: errors.length === 0,
    name: parsed.name,
    description: parsed.description,
    alwaysApply: parsed.alwaysApply,
    errors,
    warnings,
  };
}

function resolveLiveDeploymentDirectory(): string {
  const live = getDeploymentSkillRegistry().getDirectory();
  if (live) {
    return live;
  }
  return resolveDeploymentSkillDirectory().directory;
}

/**
 * Validate, persist, and hot-reload a `SKILL.md` drafted in the builder panel.
 *
 * Writes the document to `<deploymentDir>/<slug>/SKILL.md` and then calls
 * {@link reloadDeploymentSkills}, which re-validates the whole directory and
 * atomically swaps the live registry. If the reload throws (duplicate name,
 * malformed sibling skill, etc.) the freshly written file is removed so a
 * failed build leaves no orphaned skill on disk, and the error propagates.
 */
export async function buildDeploymentSkill(raw: string): Promise<SkillBuilderWriteResult> {
  const validation = validateSkillMarkdown(raw);
  if (!validation.valid) {
    const error = new Error('SKILL.md validation failed') as Error & {
      code: string;
      issues: ValidationIssue[];
    };
    error.code = 'SKILL_VALIDATION_FAILED';
    error.issues = validation.errors;
    throw error;
  }

  const slug = toSlug(validation.name);
  if (!slug) {
    const error = new Error('Skill name does not yield a valid directory') as Error & {
      code: string;
    };
    error.code = 'SKILL_VALIDATION_FAILED';
    throw error;
  }

  const rootDirectory = resolveLiveDeploymentDirectory();
  const skillDirectory = path.join(rootDirectory, slug);
  const skillMdPath = path.join(skillDirectory, 'SKILL.md');

  const existedBefore = fs.existsSync(skillMdPath);
  await fs.promises.mkdir(skillDirectory, { recursive: true });
  await fs.promises.writeFile(skillMdPath, raw, 'utf8');

  let reload: DeploymentSkillReloadResult;
  try {
    reload = await reloadDeploymentSkills();
  } catch (error) {
    if (!existedBefore) {
      await fs.promises.rm(skillDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }

  return {
    name: validation.name,
    directory: skillDirectory,
    relativeDirectory: path.relative(rootDirectory, skillDirectory),
    reload,
  };
}
