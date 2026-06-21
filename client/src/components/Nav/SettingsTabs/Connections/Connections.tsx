import { useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import {
  Label,
  Button,
  Spinner,
  OGDialog,
  OGDialogTitle,
  OGDialogHeader,
  OGDialogTrigger,
  OGDialogContent,
  useToastContext,
} from '@librechat/client';
import type { TConnection, TConnectionInput } from './useConnections';
import {
  useConnectionsQuery,
  useCreateConnectionMutation,
  useUpdateConnectionMutation,
  useDeleteConnectionMutation,
} from './useConnections';
import ConnectionForm from './ConnectionForm';
import { useLocalize } from '~/hooks';

type EditorState = { mode: 'create' } | { mode: 'edit'; connection: TConnection } | null;

export default function Connections() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [open, setOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);

  const { data: connections = [], isLoading } = useConnectionsQuery();
  const createMutation = useCreateConnectionMutation();
  const updateMutation = useUpdateConnectionMutation();
  const deleteMutation = useDeleteConnectionMutation();

  const saving = createMutation.isLoading || updateMutation.isLoading;

  const handleSubmit = (payload: TConnectionInput) => {
    const onError = (error: unknown) => {
      const message =
        (error as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        localize('com_ui_error');
      showToast({ message, status: 'error' });
    };
    const onSuccess = () => {
      showToast({ message: localize('com_ui_saved'), status: 'success' });
      setEditor(null);
    };

    if (editor?.mode === 'edit') {
      updateMutation.mutate(
        { name: editor.connection.name, payload },
        { onSuccess, onError },
      );
      return;
    }
    createMutation.mutate(payload, { onSuccess, onError });
  };

  const handleDelete = (name: string) => {
    deleteMutation.mutate(name, {
      onSuccess: () => showToast({ message: localize('com_ui_deleted'), status: 'success' }),
      onError: () => showToast({ message: localize('com_ui_error'), status: 'error' }),
    });
  };

  return (
    <div className="flex items-center justify-between">
      <Label id="connections-label">{localize('com_ui_connections')}</Label>
      <OGDialog open={open} onOpenChange={setOpen}>
        <OGDialogTrigger asChild>
          <Button variant="outline" aria-labelledby="connections-label">
            {localize('com_ui_manage')}
          </Button>
        </OGDialogTrigger>
        <OGDialogContent
          className="w-11/12 max-w-2xl bg-background text-text-primary shadow-2xl"
          aria-describedby={undefined}
        >
          <OGDialogHeader>
            <OGDialogTitle>{localize('com_ui_connections')}</OGDialogTitle>
          </OGDialogHeader>
          <p className="text-sm text-text-secondary">
            {localize('com_ui_connections_description')}
          </p>
          {isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner className="h-6 w-6 text-text-secondary" />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {connections.length === 0 && editor == null && (
                <p className="py-4 text-center text-sm text-text-secondary">
                  {localize('com_ui_connections_empty')}
                </p>
              )}
              {connections.map((connection) => (
                <div
                  key={connection.name}
                  className="flex items-center justify-between rounded-lg border border-border-light px-3 py-2"
                >
                  <div className="flex flex-col">
                    <span className="font-medium">{connection.name}</span>
                    <span className="text-xs text-text-secondary">{connection.baseURL}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={localize('com_ui_edit')}
                      onClick={() => setEditor({ mode: 'edit', connection })}
                    >
                      <Pencil className="h-4 w-4" aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={localize('com_ui_delete')}
                      disabled={deleteMutation.isLoading}
                      onClick={() => handleDelete(connection.name)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {editor != null ? (
            <ConnectionForm
              initial={editor.mode === 'edit' ? editor.connection : undefined}
              saving={saving}
              onCancel={() => setEditor(null)}
              onSubmit={handleSubmit}
            />
          ) : (
            <Button size="sm" className="ml-auto gap-1.5" onClick={() => setEditor({ mode: 'create' })}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {localize('com_ui_connection_add')}
            </Button>
          )}
        </OGDialogContent>
      </OGDialog>
    </div>
  );
}
