import { useLocation } from 'react-router-dom';
import { useConfig } from '@shared/hooks/useConfig';

// True on the responder page of a secret request (#/r/...), which keeps only
// branding and settings so nothing distracts from the requester's form. With
// requests off, /r/ links fall through to the regular error page instead.
export function useResponderPage(): boolean {
  const { SECRET_REQUESTS, SECRET_REQUESTS_DRAINING } = useConfig();
  const { pathname } = useLocation();
  return (
    (SECRET_REQUESTS || SECRET_REQUESTS_DRAINING) && pathname.startsWith('/r/')
  );
}
