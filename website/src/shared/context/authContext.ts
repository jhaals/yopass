import { createContext } from 'react';

export interface AuthState {
  loading: boolean;
  isAuthenticated: boolean;
}

export const AuthContext = createContext<AuthState>({
  loading: true,
  isAuthenticated: false,
});
