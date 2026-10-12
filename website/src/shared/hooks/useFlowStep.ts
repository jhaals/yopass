import { createContext, useContext, useEffect } from 'react';

// Share-flow progress shown by the "How it works" panel: 0 composing,
// 1 link created, 2 recipient about to open, 3 opened or no longer there.
export type FlowStep = 0 | 1 | 2 | 3;

export const FlowStepContext = createContext<(step: FlowStep) => void>(
  () => {},
);

// Reports the step of the screen currently shown.
export function useFlowStep(step: FlowStep) {
  const setStep = useContext(FlowStepContext);
  useEffect(() => setStep(step), [setStep, step]);
}
