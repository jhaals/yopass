import { AppBar, Toolbar, Typography, Button, Box, Link } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { useConfig } from './ConfigContext';

export const Header = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const { DISABLE_UPLOAD } = useConfig();
  const isOnUploadPage = location.pathname.includes('upload');
  const base = process.env.PUBLIC_URL || '';
  const home = base + '/#/';
  const upload = base + '/#/upload';
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
          {!DISABLE_UPLOAD && (
            <Button component={Link} href={isOnUploadPage ? home : upload} variant="contained" color="primary">
              {isOnUploadPage ? t("header.buttonHome") : t("header.buttonUpload")}
            </Button>
          )}
        </Box>
      </Toolbar>
    </AppBar>
  );
};
