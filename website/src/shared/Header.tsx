import { AppBar, Toolbar, Typography, Button, Box, makeStyles } from '@material-ui/core';
import { Link as RouterLink } from 'react-router-dom';

const useStyles = makeStyles((theme) => ({
  appBar: {
    marginBottom: theme.spacing(4)
  }
}));

export const Header = () => {
  const classes = useStyles();
  return (
    <AppBar position="static" className={classes.appBar}>
      <Toolbar>
        <Typography variant="h6" component="div">
          Yopass <img width="40" height="40" alt="" src="yopass.svg" />
        </Typography>
        <Box
          sx={{
            marginLeft: 'auto',
          }}
        >
          <Button
            component={RouterLink}
            to="/#/upload"
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
