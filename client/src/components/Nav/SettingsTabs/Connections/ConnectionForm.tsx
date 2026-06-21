import { useState } from 'react';
import { Input, Label, Button, Checkbox } from '@librechat/client';
import type { TConnection, TConnectionInput } from './useConnections';
import { useLocalize } from '~/hooks';

interface ConnectionFormProps {
  initial?: TConnection;
  saving?: boolean;
  onCancel: () => void;
  onSubmit: (payload: TConnectionInput) => void;
}

const MASKED_API_KEY = '__MASKED__';

export default function ConnectionForm({
  initial,
  saving,
  onCancel,
  onSubmit,
}: ConnectionFormProps) {
  const localize = useLocalize();
  const isEdit = initial != null;
  const [name, setName] = useState(initial?.name ?? '');
  const [baseURL, setBaseURL] = useState(initial?.baseURL ?? '');
  const [apiKey, setApiKey] = useState(isEdit ? MASKED_API_KEY : '');
  const [fetchModels, setFetchModels] = useState(initial?.models?.fetch ?? false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    if (name.trim().length === 0) {
      setError(localize('com_ui_connection_name_required'));
      return;
    }
    if (baseURL.trim().length === 0) {
      setError(localize('com_ui_connection_base_url_required'));
      return;
    }
    if (apiKey.length === 0) {
      setError(localize('com_ui_connection_api_key_required'));
      return;
    }
    setError(null);
    onSubmit({
      name: name.trim(),
      baseURL: baseURL.trim(),
      apiKey,
      models: { fetch: fetchModels },
    });
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border-light p-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor="connection-name">{localize('com_ui_connection_name')}</Label>
        <Input
          id="connection-name"
          value={name}
          disabled={isEdit}
          placeholder="qwen-gateway"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="connection-base-url">{localize('com_ui_connection_base_url')}</Label>
        <Input
          id="connection-base-url"
          value={baseURL}
          placeholder="https://gateway.example.com/v1"
          onChange={(e) => setBaseURL(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="connection-api-key">{localize('com_ui_connection_api_key')}</Label>
        <Input
          id="connection-api-key"
          type="password"
          value={apiKey}
          onFocus={() => {
            if (apiKey === MASKED_API_KEY) {
              setApiKey('');
            }
          }}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id="connection-fetch-models"
          aria-labelledby="connection-fetch-models-label"
          checked={fetchModels}
          onCheckedChange={(checked) => setFetchModels(checked === true)}
        />
        <Label id="connection-fetch-models-label" htmlFor="connection-fetch-models">
          {localize('com_ui_connection_fetch_models')}
        </Label>
      </div>
      {error != null && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          {localize('com_ui_cancel')}
        </Button>
        <Button size="sm" onClick={handleSubmit} disabled={saving}>
          {localize('com_ui_save')}
        </Button>
      </div>
    </div>
  );
}
