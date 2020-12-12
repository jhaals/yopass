import { Container, Link, makeStyles } from "@material-ui/core";
import { useTranslation } from 'react-i18next';

const useStyles = makeStyles((theme) => ({
  attribution: {
    display: "flex",
    justifyContent: "center",
    margin: theme.spacing(4)
  }
}));

export const Attribution = () => {
  const { t } = useTranslation();
  const classes = useStyles();
  return (
    <Container className={classes.attribution}>
        {t('Created by')}{' '}
        <Link href="https://github.com/jhaals/yopass">{t('Johan Haals')}</Link>
    </Container>
  );
};
