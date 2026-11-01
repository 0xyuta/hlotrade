import { useId } from "react";

/** The HLO halo mark on its dark badge (brand page, Tiffany direction). Geometry in a 512 box. */
const BADGE = ["#061716", "#0B2A28"];
const RING = ["#0ABAB5", "#3FE6DF", "#D9FFFD"];
const TILT = "rotate(-14 256 256)";

export function HaloLogo({ size }: { size: number }) {
  const u = `halo${useId().replace(/[^\w-]/g, "")}`; // useId gives ":r0:", which is not safe inside url(#…)
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${u}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={BADGE[0]} />
          <stop offset="1" stopColor={BADGE[1]} />
        </linearGradient>
        <linearGradient id={`${u}-ring`} gradientUnits="userSpaceOnUse" x1="150" y1="410" x2="360" y2="100">
          <stop offset="0" stopColor={RING[0]} />
          <stop offset=".55" stopColor={RING[1]} />
          <stop offset="1" stopColor={RING[2]} />
        </linearGradient>
        <mask id={`${u}-cut`} maskUnits="userSpaceOnUse" x="-50" y="-50" width="612" height="612">
          <rect x="-50" y="-50" width="612" height="612" fill="white" />
          <ellipse cx="256" cy="256" rx="126" ry="68" transform={TILT} fill="black" />
        </mask>
      </defs>
      <circle cx="256" cy="256" r="256" fill={`url(#${u}-bg)`} />
      <line x1="162.7" y1="405.3" x2="349.3" y2="106.7" stroke={`url(#${u}-ring)`} strokeWidth="56" strokeLinecap="round" mask={`url(#${u}-cut)`} />
      <ellipse cx="256" cy="256" rx="126" ry="68" transform={TILT} fill="none" stroke={`url(#${u}-ring)`} strokeWidth="60" />
    </svg>
  );
}
