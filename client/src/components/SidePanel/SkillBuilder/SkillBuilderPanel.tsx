import { useState, useCallback } from 'react';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import { Button, Spinner, useToastContext } from '@librechat/client';
import type { TSkillValidationResponse } from 'librechat-data-provider';
import { useValidateSkillBuildMutation, useBuildSkillMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';

/**
 * AI Skill Builder side panel. The model (or the user) drafts a SKILL.md from a
 * chat description; this panel validates it against the same rules the
 * deployment loader applies, then publishes it — persisting the file and
 * hot-reloading the deployment skill registry so it goes live with no restart.
 */
export default function SkillBuilderPanel() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [content, setContent] = useState('');
  const [validation, setValidation] = useState<TSkillValidationResponse | null>(null);

  const validateMutation = useValidateSkillBuildMutation({
    onSuccess: (result) => setValidation(result),
    onError: () =>
      showToast({ message: localize('com_ui_skill_builder_publish_failed'), status: 'error' }),
  });

  const buildMutation = useBuildSkillMutation({
    onSuccess: (result) => {
      setValidation(null);
      showToast({
        message: localize('com_ui_skill_builder_published', { 0: result.name }),
        status: 'success',
      });
    },
    onError: (error: unknown) => {
      const message =
        (error as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        localize('com_ui_skill_builder_publish_failed');
      showToast({ message, status: 'error' });
    },
  });

  const trimmed = content.trim();
  const isBusy = validateMutation.isLoading || buildMutation.isLoading;

  const handleValidate = useCallback(() => {
    if (trimmed.length === 0) return;
    validateMutation.mutate(content);
  }, [content, trimmed, validateMutation]);

  const handlePublish = useCallback(() => {
    if (trimmed.length === 0) return;
    buildMutation.mutate(content);
  }, [content, trimmed, buildMutation]);

  return (
    <div className="flex h-full w-full flex-col gap-3 overflow-y-auto p-3">
      <div>
        <h3 className="text-sm font-semibold text-text-primary">
          {localize('com_ui_skill_builder')}
        </h3>
        <p className="mt-1 text-xs text-text-secondary">
          {localize('com_ui_skill_builder_description')}
        </p>
      </div>

      <label htmlFor="skill-builder-editor" className="text-xs font-medium text-text-secondary">
        {localize('com_ui_skill_builder_editor_label')}
      </label>
      <textarea
        id="skill-builder-editor"
        aria-label={localize('com_ui_skill_builder_editor_label')}
        className="min-h-[16rem] w-full resize-y rounded-md border border-border-medium bg-surface-secondary p-2 font-mono text-xs text-text-primary focus:outline-none focus:ring-2 focus:ring-border-heavy"
        placeholder={localize('com_ui_skill_builder_placeholder')}
        value={content}
        spellCheck={false}
        onChange={(e) => {
          setContent(e.target.value);
          setValidation(null);
        }}
      />

      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={isBusy || trimmed.length === 0}
          onClick={handleValidate}
        >
          {validateMutation.isLoading ? <Spinner className="size-4" /> : null}
          {localize('com_ui_skill_builder_validate')}
        </Button>
        <Button
          disabled={isBusy || trimmed.length === 0 || validation?.valid === false}
          onClick={handlePublish}
        >
          {buildMutation.isLoading ? <Spinner className="size-4" /> : null}
          {localize('com_ui_skill_builder_publish')}
        </Button>
      </div>

      {trimmed.length === 0 && (
        <p className="text-xs text-text-tertiary">{localize('com_ui_skill_builder_empty')}</p>
      )}

      {validation && (
        <div className="flex flex-col gap-2 text-xs">
          {validation.valid && validation.errors.length === 0 ? (
            <div className="flex items-center gap-1.5 text-green-600 dark:text-green-500">
              <CheckCircle2 className="size-4" />
              <span>{localize('com_ui_skill_builder_valid')}</span>
            </div>
          ) : null}
          {validation.errors.map((issue, i) => (
            <div
              key={`err-${i}`}
              className="flex items-start gap-1.5 text-red-600 dark:text-red-500"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="font-medium">{issue.field}:</span> {issue.message}
              </span>
            </div>
          ))}
          {validation.warnings.map((issue, i) => (
            <div
              key={`warn-${i}`}
              className="flex items-start gap-1.5 text-amber-600 dark:text-amber-500"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="font-medium">{issue.field}:</span> {issue.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
