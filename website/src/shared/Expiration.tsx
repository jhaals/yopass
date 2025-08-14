import { Control, Controller } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import {
  FormControl,
  FormControlLabel,
  FormLabel,
  Radio,
  RadioGroup,
} from '@mui/material';

export const Expiration = (props: { control: Control<any> }) => {
  const { t } = useTranslation();
  return (
    <FormControl component="fieldset" margin="dense">
      <FormLabel component="legend">{t('expiration.legend')}</FormLabel>
      <Controller
        rules={{ required: true }}
        control={props.control}
        defaultValue="3600"
        name="expiration"
        render={({ field }) => (
          <RadioGroup
            {...field}
            row
            sx={{
              root: {
                radioGroup: {
                  justifyContent: 'center',
                },
              },
            }}
          >
            <FormControlLabel
              labelPlacement="end"
              value="3600"
              control={<Radio color="primary" />}
              label={t('expiration.optionOneHourLabel') as string}
            />
            <FormControlLabel
              labelPlacement="end"
              value="86400"
              control={<Radio color="primary" />}
              label={t('expiration.optionOneDayLabel') as string}
            />
            <FormControlLabel
              labelPlacement="end"
              value="604800"
              control={<Radio color="primary" />}
              label={t('expiration.optionOneWeekLabel') as string}
            />
            <FormControlLabel
              labelPlacement="end"
              value="2592000"
              control={<Radio color="primary" />}
              label={t('expiration.optionOneMonthLabel') as string}
            />
          </RadioGroup>
        )}
      />
    </FormControl>
  );
};
export default Expiration;
