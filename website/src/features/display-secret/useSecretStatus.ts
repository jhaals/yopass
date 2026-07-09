import { useAsync } from 'react-use';
import { getSecretStatus } from '@shared/lib/api';
import type { SecretStatus } from '@shared/lib/api';
import { useConfig } from '@shared/hooks/useConfig';

// Non-destructive status prefetch for a secret. Resolves to undefined while
// disabled so a consumer can gate it on config or user action.
export default function useSecretStatus(
  key: string,
  isFile: boolean,
  enabled: boolean,
) {
  const { OIDC_ENABLED } = useConfig();

  return useAsync(async (): Promise<SecretStatus | undefined> => {
    if (!enabled) {
      return undefined;
    }
    const { data, status, message } = await getSecretStatus(
      key,
      isFile,
      OIDC_ENABLED,
    );
    if (status === 404) {
      throw new Error('Secret not found');
    }
    if (!data) {
      throw new Error(message ?? 'Failed to check status');
    }
    return data;
  }, [enabled, key, isFile, OIDC_ENABLED]);
}
