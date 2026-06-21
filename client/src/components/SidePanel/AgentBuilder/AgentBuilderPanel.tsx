import React, { useMemo, useState } from 'react';
import { Button, Label, Input, Spinner, useToastContext } from '@librechat/client';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import type { AgentCreateParams, AgentDraftResponse } from 'librechat-data-provider';
import { useDraftAgentMutation, useCreateAgentMutation } from '~/data-provider';
import { useLocalize, useHasAccess } from '~/hooks';

const extractErrorMessage = (error: unknown, fallback: string): string => {
  if (error && typeof error === 'object' && 'response' in error) {
    const data = (error as { response?: { data?: { error?: string } } }).response?.data;
    if (data?.error) {
      return data.error;
    }
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
};

export default function AgentBuilderPanel() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const hasCreateAccess = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.CREATE,
  });

  const [description, setDescription] = useState('');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [draft, setDraft] = useState<AgentDraftResponse | null>(null);

  const buildParams = (): AgentCreateParams => ({
    name: null,
    description: description.trim() ? description.trim() : null,
    instructions: description.trim() ? description.trim() : null,
    tools: [],
    provider: provider.trim(),
    model: model.trim() ? model.trim() : null,
    model_parameters: {
      temperature: null,
      maxContextTokens: null,
      max_context_tokens: null,
      max_output_tokens: null,
      top_p: null,
      frequency_penalty: null,
      presence_penalty: null,
    },
  });

  const draftMutation = useDraftAgentMutation({
    onSuccess: (data) => setDraft(data),
    onError: (error) =>
      showToast({ message: extractErrorMessage(error, localize('com_ui_error')), status: 'error' }),
  });

  const createMutation = useCreateAgentMutation({
    onSuccess: () => {
      showToast({ message: localize('com_ui_created'), status: 'success' });
      setDraft(null);
      setDescription('');
    },
    onError: (error) =>
      showToast({ message: extractErrorMessage(error, localize('com_ui_error')), status: 'error' }),
  });

  const canDraft = useMemo(
    () => hasCreateAccess && description.trim().length > 0 && provider.trim().length > 0,
    [hasCreateAccess, description, provider],
  );

  const handleDraft = () => {
    if (!canDraft) {
      showToast({ message: localize('com_ui_field_required'), status: 'error' });
      return;
    }
    draftMutation.mutate(buildParams());
  };

  const handleCreate = () => {
    if (!draft) {
      return;
    }
    const { author: _author, ...params } = draft.agent;
    createMutation.mutate(params as AgentCreateParams);
  };

  if (!hasCreateAccess) {
    return null;
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3 text-sm">
      <div className="space-y-2">
        <Label htmlFor="agent-builder-description" className="text-sm font-medium text-text-primary">
          {localize('com_ui_description')}
        </Label>
        <textarea
          id="agent-builder-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={localize('com_agents_description_placeholder')}
          className="min-h-[120px] w-full resize-none rounded-lg border border-border-light bg-transparent px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-heavy"
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-2">
          <Label htmlFor="agent-builder-provider" className="text-sm font-medium text-text-primary">
            {localize('com_ui_provider')}
          </Label>
          <Input
            id="agent-builder-provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="w-full"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="agent-builder-model" className="text-sm font-medium text-text-primary">
            {localize('com_ui_model')}
          </Label>
          <Input
            id="agent-builder-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full"
          />
        </div>
      </div>

      <Button onClick={handleDraft} disabled={!canDraft || draftMutation.isLoading}>
        {draftMutation.isLoading ? (
          <Spinner className="size-4" />
        ) : (
          localize('com_ui_preview')
        )}
      </Button>

      {draft != null && (
        <div className="space-y-3 rounded-lg border border-border-light p-3">
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-text-secondary">
            {JSON.stringify(draft.agent, null, 2)}
          </pre>
          {draft.droppedTools.length > 0 && (
            <p className="text-xs text-text-warning">
              {localize('com_ui_agent_builder_dropped_tools', {
                0: draft.droppedTools.join(', '),
              })}
            </p>
          )}
          <Button
            onClick={handleCreate}
            disabled={createMutation.isLoading}
            className="w-full text-white"
          >
            {createMutation.isLoading ? <Spinner className="size-4" /> : localize('com_ui_create')}
          </Button>
        </div>
      )}
    </div>
  );
}
