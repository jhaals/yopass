import {
  AppBar,
  Toolbar,
  Typography,
  Button,
  Box,
  makeStyles,
  Link,
} from '@material-ui/core';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink, useLocation } from 'react-router-dom';
// import userManager from "../services/userManager";
// import { AuthProvider, AuthProviderProps, useAuth } from 'oidc-react';


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
  const base = process.env.PUBLIC_URL || '';
  const home = base + '/';
  const classes = useStyles();

  // TODO: Figure out how to sign in from outside of the AuthProvider
  // const auth = useAuth();

  var WebFont = require('webfontloader');

  WebFont.load({
    google: {
      families: [
        'Red Hat Display',
        'Red Hat Text',
        'Style Script',
        'Ubuntu'
      ]
    }
  });

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
        <Typography
          className={classes.slogan}
          style={{fontFamily: "Red Hat Display, sans-serif"}}
          >{"Share Secrets Securely (Preview)"}</Typography>
        <Box
          sx={{
            marginLeft: 'auto',
            padding: '1em',
            display: 'flex'
          }}
        >
          {/* <h4>Hello!</h4> */}
          {/* <h4>Hello {auth.userManager.getUser.name}!</h4> */}

          <Button
            disabled={true} // TODO: Enable only after user authenticated.
            component={RouterLink}
            to={isOnUploadPage ? '/' : '/upload'}
            variant="contained"
            color="primary"
            style={{fontFamily: "Red Hat Display, sans-serif"}}
          >
            {isOnUploadPage ? t('Home') : t('Upload')}
          </Button>

          <Button
            component={RouterLink}
            to={isOnUploadPage ? '/login' : '/blank'}
            variant="contained"
            color="primary"
            style={{ fontFamily: "Red Hat Display, sans-serif", marginLeft: '1rem' }}
          >
            {isOnUploadPage ? t('Log In') : t('Log-In')}
          </Button>
        </Box>
      </Toolbar>
    </AppBar>
  );
};
