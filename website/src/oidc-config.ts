import { AuthProviderProps } from 'oidc-react';

export const oidcConfig: AuthProviderProps = {
  onSignIn: async (user: any) => {
    console.log('Signed in! User is: ', user);
    window.location.hash = '';
  },
  authority: process.env.REACT_APP_ELVID_AUTHORITY,
  clientId: process.env.REACT_APP_ELVID_CLIENT_ID,
  responseType: 'code',
  redirectUri:
    process.env.NODE_ENV === 'development'
      ? 'http://localhost:3000/callback'
      : 'https://onetime.test-elvia.io',
};
