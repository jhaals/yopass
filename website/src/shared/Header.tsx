import {
  AppBar,
  Toolbar,
  Typography,
  Button,
  Box,
  makeStyles,
  Link,
} from '@material-ui/core';
import { Link as RouterLink } from 'react-router-dom';

const useStyles = makeStyles((theme) => ({
  appBar: {
    marginBottom: theme.spacing(4),
  },
  logo: {
    verticalAlign: 'middle',
    paddingLeft: '5px',
  },
}));

export const Header = () => {
  const base = process.env.PUBLIC_URL || '';
  const home = base + '/';
  const upload = base + '/upload';
  const classes = useStyles();
  return (
    <AppBar position="static" className={classes.appBar}>
      <Toolbar>
        <Typography variant="h6" component="div">
          <Link href={home} color="inherit" underline="none">
            Yopass
            <img
              className={classes.logo}
              width="40"
              height="40"
              alt=""
              src="yopass.svg"
            />
          </Link>
        </Typography>
        <Box
          sx={{
            marginLeft: 'auto',
          }}
        >
          <Button
            component={RouterLink}
            to={upload}
            variant="contained"
            color="secondary"
          >
            Upload
          </Button>
        </Box>
      </Toolbar>
    </AppBar>
  );
};
