import { createUserManager } from 'redux-oidc'

const redirectUri =
  typeof window !== 'undefined' && window && `${window.location.origin}`

const isDevelopment = process.env.NODE_ENV !== 'production'

const isIE11 =
  typeof window !== 'undefined' &&
  typeof document !== 'undefined' &&
  !!window.MSInputMethodContext &&
  !!document.DOCUMENT_NODE

const userManagerConfig = {
  client_id: process.env.REACT_APP_ELVID_CLIENT_ID || '',
  redirect_uri: `${window.location.protocol}//${window.location.hostname}${window.location.port ? `:${window.location.port}` : ''}/callback`,
  response_type: 'code',
  scope: process.env.REACT_APP_ELVID_SCOPE || '',
  authority: process.env.REACT_APP_ELVID_AUTHORITY || '',
  silent_redirect_uri: `${window.location.protocol}//${window.location.hostname}${window.location.port ? `:${window.location.port}` : ''}/oidc/silent-renew.html`,
  post_logout_redirect_uri: redirectUri || '',
  automaticSilentRenew: false,
  monitorSession: isIE11 || isDevelopment ? false : true,
  filterProtocolClaims: true,
  loadUserInfo: true,
}

const userManager =
  createUserManager(userManagerConfig)
  // typeof window !== 'undefined' && createUserManager(userManagerConfig)

if (process.env.NODE_ENV !== 'production') {
  console.log("UserManagerConfig:"+userManagerConfig)
}

export default userManager
