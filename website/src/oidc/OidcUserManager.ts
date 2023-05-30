import { UserManager } from 'oidc-react';
// import { WebStorageStateStore } from 'oidc-client';

if (process.env.REACT_APP_ELVID_AUTHORITY === undefined) throw new Error("Missing env var REACT_APP_ELVID_AUTHORITY")
if (process.env.REACT_APP_ELVID_CLIENT_ID === undefined) throw new Error("Missing env var REACT_APP_ELVID_CLIENT_ID")
if (process.env.REACT_APP_ELVID_REDIRECT_URI === undefined) throw new Error("Missing env var REACT_APP_ELVID_REDIRECT_URI")

const OidcUserManager = new UserManager({
  // https://github.com/IdentityModel/oidc-client-js/wiki#required-settings
  authority: process.env.REACT_APP_ELVID_AUTHORITY,
  client_id: process.env.REACT_APP_ELVID_CLIENT_ID,
  redirect_uri: process.env.REACT_APP_ELVID_REDIRECT_URI, //getRedirectUri()
  response_type: 'code',
  scope: process.env.REACT_APP_ELVID_SCOPE,
  // https://github.com/IdentityModel/oidc-client-js/wiki#other-optional-settings
  loadUserInfo: true,
  post_logout_redirect_uri:
    process.env.REACT_APP_ELVID_POST_LOGOUT_REDIRECT_URI,
  silent_redirect_uri: process.env.REACT_APP_ELVID_REDIRECT_URI, //getRedirectUri()
  // https://github.com/bjerkio/oidc-react/issues/703#issuecomment-903504956
  // revokeAccessTokenOnSignout: true,
  automaticSilentRenew: true,
  // Store userData in local storage instead of default session storage.
  // https://github.com/bjerkio/oidc-react/issues/332#issuecomment-723642762
  // arguments available from
  // https://github.com/bjerkio/oidc-react/blob/53c5adef53fe2603bd8507bb27fd3616fbd7e7c1/src/AuthContext.tsx#L46
  // userStore: new WebStorageStateStore({ store: window.localStorage }),
});

export default OidcUserManager;
