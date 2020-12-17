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
    <Typography variant="body2" color="textSecondary" align="center">
      <Container className={classes.attribution}>
        {t('Created by')}{' '}
        <Link href="https://github.com/jhaals/yopass">Johan Haals</Link>
      </Container>
    </Typography>
  );
};
