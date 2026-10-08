import type { CSSProperties } from 'react';
import { floorStyle } from '../lib/floors';

interface FloorChipProps {
  floor: string | null | undefined;
  /** Solid fill (map-pin style) instead of the tinted outline used in lists. */
  solid?: boolean;
  /** Show the full label ("Ground floor") instead of the short code ("G"). */
  long?: boolean;
}

/** Small coloured floor marker; colour comes from the shared floor palette. */
export default function FloorChip({ floor, solid = false, long = false }: FloorChipProps) {
  const style = floorStyle(floor);
  const vars = { '--chip-color': style.color, '--chip-tint': style.tint } as CSSProperties;
  return (
    <span
      className={`floor-chip${solid ? ' floor-chip--solid' : ''}`}
      style={vars}
      title={style.label}
      aria-label={style.label}
    >
      {long ? style.label : style.short}
    </span>
  );
}
