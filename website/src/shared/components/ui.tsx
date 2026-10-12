import type { ReactNode } from 'react';

// Small building blocks shared by the share-flow screens, following the
// urlx (Lever) design: 52px icon tiles, a 30px screen heading with an
// optional status pill, and the ink / outline button styles.

// On phones the main buttons span the column, a full-width thumb target.
export const primaryButtonClass =
  'inline-flex h-12 items-center gap-3 rounded-[10px] bg-primary px-[22px] text-[14.5px] font-semibold text-primary-content transition-[background-color,transform] duration-150 ease-out hover:bg-primary/90 active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer max-sm:w-full max-sm:justify-center';

export const outlineButtonClass =
  'inline-flex h-11 items-center gap-2 rounded-[10px] border border-base-content/20 bg-base-100 px-[18px] text-sm font-semibold text-base-content transition-[background-color,transform] duration-150 ease-out hover:bg-base-200 active:scale-[.97] cursor-pointer max-sm:w-full max-sm:justify-center';

// The row holding a form's main action. On phones it sticks to the bottom
// of the screen while the form scrolls, so the action is always one thumb
// away; from small tablets up it sits inline under the form.
export function ActionBar({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-[max(1.25rem,env(safe-area-inset-left))] flex items-center gap-4 border-t border-base-300 bg-base-100/95 px-[max(1.25rem,env(safe-area-inset-left))] pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-md sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
      {children}
    </div>
  );
}

const tileTones = {
  ink: 'bg-neutral text-secondary',
  lime: 'bg-secondary text-secondary-content',
  quiet: 'bg-base-200 text-base-content/70',
};

export function IconTile({
  tone = 'ink',
  size = 'lg',
  children,
}: {
  tone?: keyof typeof tileTones;
  size?: 'md' | 'lg';
  children: ReactNode;
}) {
  const box =
    size === 'lg' ? 'size-[52px] rounded-[14px]' : 'size-12 rounded-xl';
  return (
    <span
      className={`grid flex-none place-items-center ${box} ${tileTones[tone]}`}
    >
      {children}
    </span>
  );
}

export function StatusPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-[26px] items-center gap-[7px] self-start rounded-full bg-success/10 px-2.5 text-[12.5px] font-semibold text-success">
      <span className="size-[7px] rounded-full bg-success" />
      {children}
    </span>
  );
}

export function ScreenHeading({
  title,
  children,
}: {
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="m-0 text-[26px] leading-[1.12] font-semibold tracking-[-0.028em] text-pretty sm:text-[30px]">
        {title}
      </h2>
      {children && (
        <p className="m-0 max-w-[560px] text-sm leading-relaxed text-base-content/75 text-pretty">
          {children}
        </p>
      )}
    </div>
  );
}
