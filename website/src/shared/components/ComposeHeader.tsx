import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfig } from '@shared/hooks/useConfig';
import { useFlowStep } from '@shared/hooks/useFlowStep';
import { FileIcon, MessageIcon } from './icons';
import { ScreenHeading } from './ui';

type Mode = 'text' | 'file';

// The tab drawn last. Message and File are separate routes, so switching
// remounts this header; starting from the previous tab lets the thumb slide.
let shownMode: Mode | undefined;

// Title, intro and the Message / File switch shared by both compose screens.
export default function ComposeHeader({ mode }: { mode: Mode }) {
  const { t } = useTranslation();
  const { DISABLE_UPLOAD } = useConfig();
  const [thumb, setThumb] = useState<Mode>(shownMode ?? mode);
  useFlowStep(0);

  useEffect(() => {
    shownMode = mode;
    const frame = requestAnimationFrame(() => setThumb(mode));
    return () => cancelAnimationFrame(frame);
  }, [mode]);

  function tab(value: Mode) {
    return `relative flex h-9 items-center justify-center gap-[7px] text-[13.5px] font-semibold no-underline transition-colors duration-200 ${
      thumb === value ? 'text-base-content' : 'text-base-content/70'
    }`;
  }

  return (
    <>
      <ScreenHeading title={t('create.title')}>
        {t('create.subtitle')}
      </ScreenHeading>
      {!DISABLE_UPLOAD && (
        <div
          role="tablist"
          className="relative grid w-[280px] max-w-full grid-cols-2 rounded-[11px] bg-base-200 p-[3px] max-sm:w-full"
        >
          <span
            aria-hidden="true"
            className={`absolute top-[3px] left-[3px] h-[calc(100%-6px)] w-[calc(50%-3px)] rounded-lg bg-base-100 shadow-[0_1px_2px_rgb(11_13_18/.12),0_3px_10px_rgb(11_13_18/.06)] transition-transform duration-[400ms] ease-lv ${
              thumb === 'file' ? 'translate-x-full' : ''
            }`}
          />
          <a
            role="tab"
            aria-selected={mode === 'text'}
            href="#/"
            className={tab('text')}
          >
            <MessageIcon className="size-[15px]" />
            {t('create.tabMessage')}
          </a>
          <a
            role="tab"
            aria-selected={mode === 'file'}
            href="#/upload"
            className={tab('file')}
          >
            <FileIcon className="size-[15px]" />
            {t('create.tabFile')}
          </a>
        </div>
      )}
    </>
  );
}
