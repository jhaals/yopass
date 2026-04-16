import { useContext } from 'react';
import { AuthContext } from '@shared/context/authContext';

export function useAuth() {
  return useContext(AuthContext);
}
