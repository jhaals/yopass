import { useTranslation } from 'react-i18next';

export type ConfirmActionType =
  | 'revoke'
  | 'rotate'
  | 'remove'
  | 'clearCollected'
  | 'purgeAll';

interface ConfirmActionModalProps {
  type: ConfirmActionType;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmActionModal({
  type,
  onConfirm,
  onCancel,
}: ConfirmActionModalProps) {
  const { t } = useTranslation();
  return (
    <div className="modal modal-open" role="dialog">
      <div className="modal-box">
        <h3 className="font-bold text-lg mb-2">
          {t(`request.confirm.${type}Title`)}
        </h3>
        <p className="text-sm text-base-content/70">
          {t(`request.confirm.${type}Message`)}
        </p>
        <div className="modal-action">
          <button className="btn btn-error btn-sm" onClick={onConfirm}>
            {t(`request.confirm.${type}Confirm`)}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>
            {t('delete.dialogCancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
