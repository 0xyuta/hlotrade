/** Profiles.AVATAR_COUNT. Avatars are built in: a pure function of the id, drawn by ui/Avatar.tsx. */
export const AVATAR_COUNT = 32;

export interface AvatarSpec {
  bg: string;
  fg: string;
  shape: "circle" | "square" | "diamond" | "triangle";
}

const PALETTE: [string, string][] = [
  ["#e2572b", "#fffaf3"], ["#1f9d6b", "#f4fff9"], ["#3b6fd8", "#f3f7ff"], ["#b7791f", "#fffbf2"],
  ["#8a4fbf", "#fbf5ff"], ["#d6453d", "#fff5f4"], ["#2a2118", "#f6f1e7"], ["#0f8a8a", "#f1ffff"],
];
const SHAPES: AvatarSpec["shape"][] = ["circle", "square", "diamond", "triangle"];

export function avatarSpec(id: number): AvatarSpec {
  if (!Number.isInteger(id) || id < 0 || id >= AVATAR_COUNT) throw new Error(`avatar id ${id} out of range`);
  const [bg, fg] = PALETTE[id % 8];
  return { bg, fg, shape: SHAPES[Math.floor(id / 8)] };
}
