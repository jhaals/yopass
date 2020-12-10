import { UseFormMethods } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { FormGroup, FormText, Input, Label } from 'reactstrap';

export const Lifetime = (props: { register: UseFormMethods['register'] }) => {
  const { t } = useTranslation();

  const buttons = [];
  for (const i of [
    {
      duration: 3600,
      name: '1h',
      text: t('One Hour'),
    },
    {
      duration: 86400,
      name: '1d',
      text: t('One Day'),
    },
    {
      duration: 604800,
      name: '1w',
      text: t('One Week'),
    },
  ]) {
    buttons.push(
      <FormGroup key={i.name} check={true} inline={true}>
        <Label check={true}>
          <Input
            type="radio"
            name="lifetime"
            defaultChecked={i.duration === 3600}
            value={i.duration}
            innerRef={props.register({ required: true })}
          />
          {i.text}
        </Label>
      </FormGroup>,
    );
  }

  return (
    <FormGroup tag="fieldset">
      <FormText color="muted">
        {t('The encrypted message will be deleted automatically after')}
      </FormText>
      {buttons}
    </FormGroup>
  );
};
export default Lifetime;
