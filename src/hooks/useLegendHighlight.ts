import { useState, useCallback } from 'react';

type LegendEntry = { dataKey?: string | number | ((obj: unknown) => unknown) };

export default function useLegendHighlight() {
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  const toKey = (o: LegendEntry): string | null =>
    typeof o.dataKey === 'string' ? o.dataKey : null;

  const handleMouseEnter = useCallback(
    (o: LegendEntry) => { if (!locked) setHighlighted(toKey(o)); },
    [locked],
  );

  const handleMouseLeave = useCallback(
    () => { if (!locked) setHighlighted(null); },
    [locked],
  );

  const handleClick = useCallback(
    (o: LegendEntry) => {
      const key = toKey(o);
      if (locked && highlighted === key) {
        setLocked(false);
        setHighlighted(null);
      } else {
        setHighlighted(key);
        setLocked(true);
      }
    },
    [locked, highlighted],
  );

  const opacity = useCallback(
    (seriesKey: string) => (highlighted === null || highlighted === seriesKey ? 1 : 0.15),
    [highlighted],
  );

  return { highlighted, handleMouseEnter, handleMouseLeave, handleClick, opacity } as const;
}
