import { AuthProviderProps } from 'oidc-react';
import OidcUserManager from './OidcUserManager';

export const OidcConfiguration: AuthProviderProps = {
  onSignIn: async (user: any) => {
    console.log('Signed in! User: ', user);
    window.location.hash = '';
  },
  onSignOut: async (user: any) => {
    console.log('Signed out! User: ', user);
    window.location.hash = '';
  },
  autoSignIn: false,
  userManager: OidcUserManager,
  // authority: process.env.REACT_APP_ELVID_AUTHORITY,
  // clientId: process.env.REACT_APP_ELVID_CLIENT_ID,
  // scope: process.env.REACT_APP_ELVID_SCOPE,
  // responseType: 'code',
  // redirectUri: process.env.REACT_APP_ELVID_REDIRECT_URI, //getRedirectUri()
  // postLogoutRedirectUri: process.env.REACT_APP_ELVID_POST_LOGOUT_REDIRECT_URI
};

// NOTE:
// The NODE_ENV production value does _NOT_ mean
// Elvia production runtime environment. It is both totally unrelated..

// function getRedirectUri(): string {
//   switch (process.env.NODE_ENV) {
//     case 'development':
//       if (backendDomain.includes('localhost')
//         || backendDomain.includes('127.0.0.1'))
//         return 'http://localhost:3000/callback';
//       else
//         return 'https://onetime.dev-elvia.io';
//     case 'test':
//       return 'https://onetime.test-elvia.io';
//     case 'production':
//       return 'https://onetime.elvia.io';
//     default:
//       return 'https://onetime.elvia.io';
//   }
// }

console.log(OidcConfiguration);
