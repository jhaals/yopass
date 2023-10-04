import { AppBar, Toolbar, Typography, Button, Box, Link } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';

export const Header = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const isOnUploadPage = location.pathname.includes('upload');
  const base = process.env.PUBLIC_URL || '';
  const home = base + '/#/';
  const upload = base + '/#/upload';
  return (
    <AppBar position="static" color="transparent" sx={{ marginBottom: 4 }}>
      <Toolbar>
        <Link href={home} color="inherit" underline="none">
          <Typography variant="h6" component="div">
            <Box
              sx={{
                verticalAlign: 'middle',
                padding: '20px',
                width: '112px',
                height: '40px',
              }}
              component="img"
              height="40"
              alt=""
              src="group24.svg"
            />
          </Typography>
        </Link>
        <Box
          sx={{
            marginLeft: 'auto',
          }}
        >
          <Button
            component={Link}
            href={isOnUploadPage ? home : upload}
            variant="contained"
            sx={{ 
              borderRadius: "20px",
              backgroundImage: "linear-gradient(45deg,#0096bb,#6cbe99)",
              fontSize: "16px",
              paddingTop: "10px",
              paddingBottom: "10px",
              paddingLeft:"35px",
              paddingRight: "35px"
            }}
          >
            {isOnUploadPage ? t('header.buttonHome') : t('header.buttonUpload')}
          </Button>
        </Box>
      </Toolbar>
    </AppBar>
  );
};
