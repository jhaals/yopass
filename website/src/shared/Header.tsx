import {
  AppBar,
  Toolbar,
  Typography,
  Button,
  Box,
  Link,
} from '@mui/material';
import { useAuth } from 'oidc-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink, useLocation } from 'react-router-dom';

export const Header = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const isOnUploadPage = location.pathname.includes('upload');
  const isOnCreatePage = location.pathname.includes('create');
  // const base = process.env.PUBLIC_URL || '';
  const home = '/';
  const upload = '/upload';
  const create = '/create';

  var WebFont = require('webfontloader');

  const currentLocationHref = window.location.href; // returns the absolute URL of a page
  console.log('window.location.href: ' + currentLocationHref);
  const currentLocationPathname = window.location.pathname; //returns the current url minus the domain name
  console.log('window.location.pathname: ' + currentLocationPathname);

  var isHome = false;
  if (currentLocationHref.endsWith('/#/')) {
    isHome = true;
  }

  WebFont.load({
    google: {
      families: ['Red Hat Display', 'Red Hat Text', 'Ubuntu'],
    },
  });

  var auth = useAuth();
  var [isUserSignedOut, setIsUserSignedOut] = useState(true);

  var username = auth?.userData?.profile?.username as string;
  if (username && (username.trim() === '' || username.trim().length === 0))
    console.log(username);

  var signIn = () => {
    if (!auth) {
      console.error('Unknown sign-in error.');
      return;
    }

    // var signIn = isUserSignedOut ? auth.signIn : auth.signOut;
    var signIn = auth.signIn;

    signIn().then(console.log).catch(console.error);
  };

  var signOut = () => {
    if (!auth) {
      console.error('Unknown sign-out error.');
      return;
    }

    // var signOut = isUserSignedOut ? auth.signIn : auth.signOut;
    var signOut = auth.signOut;
    signOut()
      .then((e) => {
        console.log('Signing out....:', e);
        // https://github.com/maxmantz/redux-oidc/issues/134#issuecomment-458777955
        auth.userManager.clearStaleState();
        // https://github.com/maxmantz/redux-oidc/issues/134#issuecomment-472380722
        auth.userManager.removeUser(); // remove user data from the client application
        auth.userManager.signoutRedirect(); // sign out completely at the authentication server
      })
      .catch((error) => console.error('Failed signing out: ', error));
  };

  useEffect(() => {
    setIsUserSignedOut(!auth.userData);
  }, [auth.userData]);

  useEffect(() => {
    console.log('User data is: ', auth.userData);
  });

  return (
    <AppBar position="static" color="transparent">
      <Toolbar>
        <Link href={home} color="inherit" underline="none">
          <Typography variant="h6" component="div">
            <img
              data-test-id="headerIconImage"
              width="80"
              height="40"
              alt=""
              src="elvia_logo.svg"
            />
          </Typography>
        </Link>
        <Link href={home} color="inherit" underline="none">
          <Typography
            data-test-id="headerDescription"
            style={{ fontFamily: 'Red Hat Display, sans-serif' }}
          >
            {' Share Secrets Securely'}
          </Typography>
        </Link>
        <Box
          sx={{
            marginLeft: 'auto',
            padding: '1em',
            display: 'flex',
          }}
        >
          {isHome && (
            <Button
              data-test-id="userButton"
              onClick={isUserSignedOut ? signIn : signOut}
              variant="contained"
              color="primary"
              style={{
                fontFamily: 'Red Hat Display, sans-serif',
                marginLeft: '1rem',
              }}
            >
              {isUserSignedOut
                ? t('header.buttonSignIn')
                : t('header.buttonSignOut')}
            </Button>
          )}

          {!isUserSignedOut && (
            <Button
              data-test-id="createButton"
              // disabled={isOnCreatePage ? true : false}
              component={RouterLink}
              to={isOnCreatePage ? home : create}
              variant="contained"
              color="primary"
              style={{
                fontFamily: 'Red Hat Display, sans-serif',
                marginLeft: '1rem',
              }}
            >
              {isOnCreatePage
                ? t('header.buttonHome')
                : t('header.buttonCreate')}
            </Button>
          )}

          {!isUserSignedOut && (
            <Button
              data-test-id="uploadButton"
              // disabled={isOnUploadPage ? true : false}
              component={RouterLink}
              to={isOnUploadPage ? home : upload}
              variant="contained"
              color="primary"
              style={{
                fontFamily: 'Red Hat Display, sans-serif',
                marginLeft: '1rem',
              }}
            >
              {isOnUploadPage
                ? t('header.buttonHome')
                : t('header.buttonUpload')}
            </Button>
          )}
        </Box>
      </Toolbar>
    </AppBar>
  );
};
