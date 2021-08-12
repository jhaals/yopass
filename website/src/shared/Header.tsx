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
  const isOnCreatePage = location.pathname.includes('create');
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
        <Link href={home} color="inherit" underline="none">
          <Typography
            className={classes.slogan}
            style={{fontFamily: "Red Hat Display, sans-serif"}}
            >
            {"Share Secrets Securely (Preview)"}
          </Typography>
        </Link>
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
            disabled={isOnCreatePage ? true : false}
            component={RouterLink}
            to={isOnCreatePage ? '/' : '/create'}
            variant="contained"
            color="primary"
            style={{ fontFamily: "Red Hat Display, sans-serif", marginLeft: '1rem' }}
          >
            {isOnCreatePage ? t('Encrypt') : t('Encrypt')}
          </Button>

          <Button
            disabled={isOnUploadPage ? true : false}
            component={RouterLink}
            to={isOnUploadPage ? '/' : '/upload'}
            variant="contained"
            color="primary"
            style={{ fontFamily: "Red Hat Display, sans-serif", marginLeft: '1rem' }}
          >
            {isOnUploadPage ? t('Upload') : t('Upload')}
          </Button>

        </Box>
      </Toolbar>
    </AppBar>
  );
};
