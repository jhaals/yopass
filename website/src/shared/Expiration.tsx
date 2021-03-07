import { Controller, UseFormMethods } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import {
  FormControl,
  FormControlLabel,
  FormLabel,
  Radio,
  RadioGroup,
} from '@material-ui/core';

export const Expiration = (props: { control: UseFormMethods['control'] }) => {
  const { t } = useTranslation();

  return (
    <FormControl component="fieldset">
      <FormLabel component="legend">
        {t('The encrypted message will be deleted automatically after')}
      </FormLabel>
      <Controller
        rules={{ required: true }}
        control={props.control}
        defaultValue="3600"
        name="expiration"
        as={
          <RadioGroup row>
            <FormControlLabel
              labelPlacement="end"
              value="3600"
              control={<Radio />}
              label={t('One Hour')}
            />
            <FormControlLabel
              labelPlacement="end"
              value="86400"
              control={<Radio />}
              label={t('One Day')}
            />
            <FormControlLabel
              labelPlacement="end"
              value="604800"
              control={<Radio />}
              label={t('One Week')}
            />
          </RadioGroup>
        }
      />
    </FormControl>
  );
};
export default Expiration;
