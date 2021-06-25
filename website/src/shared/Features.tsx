import {
  faCodeBranch,
  faDownload,
  faLock,
  faShareAlt,
  faUserAltSlash,
  IconDefinition,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useTranslation } from 'react-i18next';
import {
  createStyles,
  Grid,
  makeStyles,
  Paper,
  Typography,
  Divider,
  Box,
} from '@material-ui/core';

const useStyles = makeStyles((theme) =>
  createStyles({
    feature: {
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      alignItems: 'center',
      minHeight: 230,
      padding: 16,
    },
    featureHeader: {
      padding: 10,
    },
    divider: {
      padding: theme.spacing(1),
    },
    header: {
      padding: theme.spacing(2),
    },
  }),
);

export const Features = () => {
  const { t } = useTranslation();
  return (
    <Grid container={true} spacing={2} paddingTop={4}>
      <Grid item={true} xs={12}>
        <Divider />
      </Grid>
    </Grid>
  );
};

type FeatureProps = {
  readonly title: string;
  readonly icon: IconDefinition;
  readonly children: JSX.Element;
};

const Feature = (props: FeatureProps) => {
  const classes = useStyles();
  return (
    <Grid item={true} xs={12} md={4}>
      <Paper className={classes.feature}>
        <FontAwesomeIcon color={'black'} size={'4x'} icon={props.icon} />
        <Typography className={classes.featureHeader} variant="h5">
          {props.title}
        </Typography>
        <Typography>{props.children}</Typography>
      </Paper>
    </Grid>
  );
};
