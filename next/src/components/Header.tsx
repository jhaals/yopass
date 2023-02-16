import { AppBar, Toolbar, Typography, Box, Link } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'next/router';

export const Header = () => {
  const { t } = useTranslation();
  const router = useRouter();
  const base = process.env.PUBLIC_URL || '';
  const home = base + '/';
  return (
    <AppBar position="static" color="transparent" sx={{ marginBottom: 4 }}>
      <Toolbar>
        <Link href={home} color="inherit" underline="none">
          <Typography variant="h6" component="div">
            Yopass
            <Box
              sx={{
                verticalAlign: 'middle',
                paddingLeft: '5px',
                width: '40px',
                height: '40px',
              }}
              component="img"
              height="40"
              alt=""
              src="yopass.svg"
            />
          </Typography>
        </Link>
        <Box
          sx={{
            marginLeft: 'auto',
          }}
        >
        </Box>
      </Toolbar>
    </AppBar>
  );
};

export default Header;
