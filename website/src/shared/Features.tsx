import {
  faBomb,
  faCodeBranch,
  faDownload,
  faLock,
  faShareAlt,
  faUserAltSlash,
  IconDefinition,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useTranslation } from 'react-i18next';
import { Grid, Paper, Typography, Divider, Box } from '@mui/material';

export const Features = () => {
  const { t } = useTranslation();
  return (
    <Grid container={true} spacing={2} paddingTop={4}>
      <Grid item={true} xs={12}>
        <Divider />
        <Box p={2}>
          <Typography variant="h5" align={'center'}>
            {t('features.title')}
          </Typography>
          <Typography variant="body2" align={'center'}>
            {t('features.subtitle')}
          </Typography>
        </Box>
      </Grid>
      <Feature title={t('features.featureEndToEndTitle')} icon={faLock}>
        <>{t('features.featureEndToEndText')}</>
      </Feature>
      <Feature title={t('features.featureSelfDestructionTitle')} icon={faBomb}>
        <>{t('features.featureSelfDestructionText')}</>
      </Feature>
      <Feature title={t('features.featureOneTimeTitle')} icon={faDownload}>
        <>{t('features.featureOneTimeText')}</>
      </Feature>
      <Feature
        title={t('features.featureSimpleSharingTitle')}
        icon={faShareAlt}
      >
        <>{t('features.featureSimpleSharingText')}</>
      </Feature>
      <Feature
        title={t('features.featureNoAccountsTitle')}
        icon={faUserAltSlash}
      >
        <>{t('features.featureNoAccountsText')}</>
      </Feature>
      <Feature title={t('features.featureOpenSourceTitle')} icon={faCodeBranch}>
        <>{t('features.featureOpenSourceText')}</>
      </Feature>
    </Grid>
  );
};

type FeatureProps = {
  readonly title: string;
  readonly icon: IconDefinition;
  readonly children: React.JSX.Element;
};

const Feature = (props: FeatureProps) => {
  return (
    <Grid item={true} xs={12} md={4}>
      <Paper
        sx={{
          backgroundColor: 'unset',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '230px',
          padding: '16px',
        }}
      >
        <FontAwesomeIcon size={'4x'} icon={props.icon} />
        <Typography sx={{ padding: '5px' }} variant="h5">
          {props.title}
        </Typography>
        <Typography>{props.children}</Typography>
      </Paper>
    </Grid>
  );
};
