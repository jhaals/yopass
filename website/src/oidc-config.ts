import { AuthProviderProps } from 'oidc-react';
import { backendDomain } from './utils/utils';

export const oidcConfig: AuthProviderProps = {
  onSignIn: async (user: any) => {
    console.log('Signed in! User is: ', user);
    window.location.hash = '';
  },
  authority: process.env.REACT_APP_ELVID_AUTHORITY,
  clientId: process.env.REACT_APP_ELVID_CLIENT_ID,
  scope: process.env.REACT_APP_ELVID_SCOPE,
  responseType: 'code',
  redirectUri: getRedirectUri()
};

function getRedirectUri(): string {
  switch (process.env.NODE_ENV) {
    case 'development':
      if (backendDomain.includes('localhost')
        || backendDomain.includes('127.0.0.1'))
        return 'http://localhost:3000/callback';
      else
        return 'https://onetime.dev-elvia.io';
    case 'test':
      return 'https://onetime.test-elvia.io';
    case 'production':
      return 'https://onetime.elvia.io';
    default:
      return 'https://onetime.elvia.io';
  }
}
