import {
  AppBar,
  Toolbar,
  Typography,
  Button,
  Box,
  makeStyles,
  Link,
} from '@material-ui/core';
import { useAuth } from 'oidc-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink, useLocation } from 'react-router-dom';

const useStyles = makeStyles((theme) => ({
  appBar: {
    marginBottom: theme.spacing(4),
  },
  logo: {
    verticalAlign: 'middle',
    paddingLeft: '5px',
  },
  slogan: {
    paddingLeft: '2.5em',
  },
}));

export const Header = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const isOnUploadPage = location.pathname.includes('upload');
  const isOnCreatePage = location.pathname.includes('create');
  const base = process.env.PUBLIC_URL || '';
  const home = base + '/';
  const upload = base + '/#/upload';
  const create = base + '/#/create';
  const classes = useStyles();

  var WebFont = require('webfontloader');

  WebFont.load({
    google: {
      families: [
        'Red Hat Display',
        'Red Hat Text',
        'Ubuntu'
      ]
    }
  });

  var auth = useAuth();
  var [isUserSignedOut, setIsUserSignedOut] = useState(true);

  var username = auth?.userData?.profile?.username;
  if (username
    && (username.trim() === "" || username.trim().length === 0))
    console.log(username)

  var signIn = () => {
    if (!auth) {
      console.error("Unknown sign-in error.");
      return;
    }

    // var signIn = isUserSignedOut ? auth.signIn : auth.signOut;
    var signIn = auth.signIn ;

    signIn().then(console.log).catch(console.error);
  }

  var signOut = () => {
    if (!auth) {
      console.error("Unknown sign-out error.");
      return;
    }

    // var signOut = isUserSignedOut ? auth.signIn : auth.signOut;
    var signOut = auth.signOut;

    signOut().then(console.log).catch(console.error);
  }

  useEffect(() => {
    setIsUserSignedOut(!auth.userData);
  }, [auth.userData])

  useEffect(() => {
    console.log('User data is: ', auth.userData);
  })

  return (
    <AppBar position="static" color="transparent" className={classes.appBar}>
      <Toolbar>
        <Link href={home} color="inherit" underline="none">
          <Typography variant="h6" component="div">
            <img
              className={classes.logo}
              width="80"
              height="40"
              alt=""
              src="https://cdn.elvia.io/npm/elvis-assets-trademark-1.0.2/dist/logo/default/elvia_charge.svg"
            />
          </Typography>
        </Link>
        <Link href={home} color="inherit" underline="none">
          <Typography
            className={classes.slogan}
            style={{ fontFamily: "Red Hat Display, sans-serif" }}
          >
            {"Share Secrets Securely"}
          </Typography>
        </Link>
        <Box
          sx={{
            marginLeft: 'auto',
            padding: '1em',
            display: 'flex'
          }}
        >
          {/* <h4>Hello {auth.userManager.getUser.name}!</h4> */}

          {<Button
            component={RouterLink}
            to={home}
            onClick={isUserSignedOut ? signIn : signOut}
            variant="contained"
            color="primary"
            style={{ fontFamily: "Red Hat Display, sans-serif", marginLeft: '1rem' }}
          >
            {isUserSignedOut ? t('Sign-In') : t('Sign-Out')}
          </Button>}

          {!isUserSignedOut && <Button
            disabled={isOnCreatePage ? true : false}
            component={RouterLink}
            to={isOnCreatePage ? home : create}
            variant="contained"
            color="primary"
            style={{ fontFamily: "Red Hat Display, sans-serif", marginLeft: '1rem' }}
          >
            {isOnCreatePage ? t('Create') : t('Create')}
          </Button>}

          {!isUserSignedOut && <Button
            disabled={isOnUploadPage ? true : false}
            component={RouterLink}
            to={isOnUploadPage ? home : upload}
            variant="contained"
            color="primary"
            style={{ fontFamily: "Red Hat Display, sans-serif", marginLeft: '1rem' }}
          >
            {isOnUploadPage ? t('Upload') : t('Upload')}
          </Button>}
        </Box>
      </Toolbar>
    </AppBar>
  );
};
