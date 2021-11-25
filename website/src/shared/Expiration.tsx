import { Controller, UseFormMethods } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import {
  FormControl,
  FormControlLabel,
  FormLabel,
  Radio,
  RadioGroup,
} from '@mui/material';
import makeStyles from '@mui/styles/makeStyles';
import { useState } from "react";
import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";

const useStyles = makeStyles({
  radioGroup: {
    justifyContent: 'center',
  },
});

export const Expiration = (props: { control: UseFormMethods['control'] }) => {
  const { t } = useTranslation();
  const classes = useStyles();
  const [startDate, setStartDate] = useState(new Date());
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
            <FormControlLabel
              labelPlacement="end"
              value="2419200"
              control={<Radio color="primary" />}
              label={t('expiration.optionFourWeekLabel')}
            />
            <FormControlLabel
              labelPlacement="end"
              value={(startDate.getTime() - (new Date()).getTime())/1000}
              control={<Radio color="primary" />}
              label={t('expiration.optionPicker')}
            />
            </RadioGroup>
        }
      />
      <DatePicker
        selected = {startDate}
        showTimeSelect
        dateFormat = "PPpp"
        onChange = {(date: Date) => setStartDate(date)}
      />
    </FormControl>
  );
};
export default Expiration;
