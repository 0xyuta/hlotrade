import { AVATAR_COUNT, avatarSpec } from "../profile/avatar";

export function Avatar({ id, size = 28 }: { id: number; size?: number }) {
  const s = avatarSpec(Math.min(Math.max(Math.floor(id), 0), AVATAR_COUNT - 1));
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill={s.bg} />
      {s.shape === "circle" && <circle cx="16" cy="16" r="7" fill={s.fg} />}
      {s.shape === "square" && <rect x="9" y="9" width="14" height="14" rx="3" fill={s.fg} />}
      {s.shape === "diamond" && <path d="M16 7 L25 16 L16 25 L7 16 Z" fill={s.fg} />}
      {s.shape === "triangle" && <path d="M16 8 L25 24 L7 24 Z" fill={s.fg} />}
    </svg>
  );
}
