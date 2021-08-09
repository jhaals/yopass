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
        <Typography className={classes.slogan}>{"Share Secrets Securely (Preview)"}</Typography>
        <Box
          sx={{
            marginLeft: 'auto',
            padding: '1em',
            display: 'flex'
          }}
        >
          <Button
            component={RouterLink}
            to={isOnUploadPage ? '/' : '/upload'}
            variant="contained"
            color="primary"
          >
            {isOnUploadPage ? t('Home') : t('Upload')}
          </Button>
        </Box>
      </Toolbar>
    </AppBar>
  );
};
