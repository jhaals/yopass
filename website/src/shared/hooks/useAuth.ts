import { useContext } from 'react';
import { AuthContext } from '@shared/context/AuthContext';

export function useAuth() {
  return useContext(AuthContext);
}
