import { Profile, User } from 'oidc-client'
import { RootState } from '../rootReducer'

export const getUser = (state: RootState): User | undefined => state.oidc.user

export const getAccessToken = (state: RootState): string | undefined =>
  state.oidc.user?.access_token

export const getUserProfile = (state: RootState): Profile | undefined =>
  state.oidc.user?.profile

export const isUserLoggedIn = (state: RootState): boolean => !!state.oidc.user
