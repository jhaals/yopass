import { Box, Container, Link } from '@mui/material';
import { Attribution } from './Attribution';
import { useTranslation } from 'react-i18next';

export const Footer = () => {
    const { t } = useTranslation();

    const privacyNotice = process.env.YOPASS_SHOW_PRIVACY_NOTICE == '1';
    const imprintUrl = process.env.YOPASS_IMPRINT_URL;
    const privacyNoticeUrl = process.env.YOPASS_PRIVACY_NOTICE_URL;

    return (
        <Box
            component="footer"
            sx={{
                py: 3,
                px: 2,
                mt: 'auto',
                marginTop: 2,
            }}
        >
            <Container maxWidth="md">
                {privacyNotice && <Box display="flex" justifyContent="center" gap={3} mb={4}>
                    <Link href={imprintUrl}>{t('footer.imprint')} </Link>
                    <Link href={privacyNoticeUrl}>{t('footer.privacyNotice')} </Link>
                </Box>}
                <Attribution />
            </Container>
        </Box>
    );
};