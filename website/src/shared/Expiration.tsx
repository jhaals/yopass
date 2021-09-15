import { Controller, UseFormMethods } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import {
  FormControl,
  FormControlLabel,
  FormLabel,
  makeStyles,
  Radio,
  RadioGroup,
} from '@material-ui/core';

const useStyles = makeStyles({
  radioGroup: {
    justifyContent: 'center',
  },
});

export const Expiration = (props: { control: UseFormMethods['control'] }) => {
  const { t } = useTranslation();
  const classes = useStyles();
  return (
    <FormControl component="fieldset" margin="dense">
      <FormLabel component="legend">{t('expiration.legend')}</FormLabel>
      <Controller
        rules={{ required: true }}
        control={props.control}
        defaultValue="3600"
        name="expiration"
        as={
          <RadioGroup
            row
            classes={{
              root: classes.radioGroup,
            }}
            style={{ fontFamily: 'Red Hat Text, sans-serif' }}
          >
            <FormControlLabel
              labelPlacement="end"
              value="3600"
              control={<Radio color="primary" />}
              label={t('expiration.optionOneHourLabel')}
            />
            <FormControlLabel
              labelPlacement="end"
              value="86400"
              control={<Radio color="primary" />}
              label={t('expiration.optionOneDayLabel')}
            />
            <FormControlLabel
              labelPlacement="end"
              value="604800"
              control={<Radio color="primary" />}
              label={t('expiration.optionOneWeekLabel')}
            />
          </RadioGroup>
        }
      />
    </FormControl>
  );
};
export default Expiration;
