import { Container, Link, makeStyles, Typography } from '@material-ui/core';
import { useTranslation } from 'react-i18next';

const useStyles = makeStyles((theme) => ({
  attribution: {
    margin: theme.spacing(4),
  },
}));

export const Attribution = () => {
  const { t } = useTranslation();
  const classes = useStyles();
  return (
    <Container className={classes.attribution}>
      <Typography variant="body2" color="textSecondary" align="center">
        {t('Created by')}{' '}
        <Link href="https://github.com/3lvia/onetime-yopass">Johan Haals</Link>
      </Typography>
    </Container>
  );
};
