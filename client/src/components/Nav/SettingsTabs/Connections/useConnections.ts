import { request } from 'librechat-data-provider';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';

export interface TConnection {
  name: string;
  baseURL: string;
  apiKey: string;
  iconURL?: string;
  models?: {
    default?: string[];
    fetch?: boolean;
  };
  headers?: Record<string, string>;
}

export type TConnectionInput = Omit<TConnection, 'iconURL'> & { iconURL?: string };

const CONNECTIONS_KEY = ['admin', 'connections'] as const;
const BASE = '/api/admin/connections';

export function useConnectionsQuery(): UseQueryResult<TConnection[]> {
  return useQuery<TConnection[]>({
    queryKey: CONNECTIONS_KEY,
    queryFn: async () => {
      const data = await request.get(BASE);
      return (data as { connections?: TConnection[] }).connections ?? [];
    },
  });
}

export function useCreateConnectionMutation(): UseMutationResult<
  unknown,
  unknown,
  TConnectionInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: TConnectionInput) => request.post(BASE, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY });
    },
  });
}

export function useUpdateConnectionMutation(): UseMutationResult<
  unknown,
  unknown,
  { name: string; payload: TConnectionInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, payload }: { name: string; payload: TConnectionInput }) =>
      request.put(`${BASE}/${encodeURIComponent(name)}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY });
    },
  });
}

export function useDeleteConnectionMutation(): UseMutationResult<unknown, unknown, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => request.delete(`${BASE}/${encodeURIComponent(name)}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY });
    },
  });
}
