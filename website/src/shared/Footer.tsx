import { AppBar, Toolbar, Typography, Button, Box, Link } from '@mui/material';

export const Footer = () => {
  return (
    <AppBar position="static" color="transparent" sx={{ position: "fixed", bottom: "0px", display: 'block', paddingLeft:"20px"}}>
      <Toolbar>
        <Link href="https://www.group24.de/legal/datenschutz/" target="_blank" underline="none" color="inherit" marginRight="30px">
            <Typography component="div">
                Datenschutz
            </Typography>
        </Link>
        <Link href="https://www.group24.de/legal/impressum/" target="_blank" color="inherit" underline="none" sx={{ float: 'right'}}>
          <Typography component="div">
            Impressum
          </Typography>
        </Link>
      </Toolbar>
    </AppBar>
  );
};
