import { createContext } from 'react';

export interface AuthState {
  loading: boolean;
  isAuthenticated: boolean;
  // The signed-in user's address, shown when a restricted secret refuses it.
  email?: string;
}

export const AuthContext = createContext<AuthState>({
  loading: true,
  isAuthenticated: false,
});
