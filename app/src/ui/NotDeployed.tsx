export function NotDeployed({ problem }: { problem: string | null }) {
  return (
    <div className="app">
      <main className="main" style={{ maxWidth: 560, justifyContent: "center" }}>
        <div className="card">
          <h1 className="card-h">HLO is not deployed on this network yet</h1>
          <p className="muted">Check back at launch.</p>
          {problem && <p className="error">Config problem: {problem}</p>}
        </div>
      </main>
    </div>
  );
}
