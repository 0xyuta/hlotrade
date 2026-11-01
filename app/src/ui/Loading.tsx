/** Shown while a lazy chunk loads. `page` wraps it in the app shell (the first paint of a route). */
export function Loading({ page = false }: { page?: boolean }) {
  const text = (
    <p className="muted small" role="status">
      Loading…
    </p>
  );
  if (!page) return text;
  return (
    <div className="app">
      <main className="main">{text}</main>
    </div>
  );
}
