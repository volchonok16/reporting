import { createContext } from 'react';
import type { DisplayRows } from './progressiveWindow';
export type ScrollEdge = { target: number; direction: 'forward' | 'backward' };
export type ProgressiveContextValue = {
  index: number; mode: DisplayRows; first: number; last: number;
  prepare: (direction: ScrollEdge['direction']) => void;
  cancel: () => void;
  commit: (index: number) => void;
  setMode: (mode: DisplayRows) => void;
  subscribe: (listener: (edge: ScrollEdge) => void) => () => void;
  reset: () => void;
};
export const ProgressiveContext = createContext<ProgressiveContextValue | undefined>(undefined);
