import { useConfig } from "../../config/context";
import { apiPageUrl, BOT_FILE, BOT_INTRO, BOT_RULES, BOT_SAMPLE_TEXT, botCommands, botSteps, builderFeeText, builderField, TERMS_URL } from "../../rewards/bots";

/** The Bots tab: how to mine with your own bot. No wallet, no key and no order passes through this screen. */
export function BotsScreen() {
  const cfg = useConfig();
  const origin = window.location.origin;
  if (!cfg.builder) return <section className="card"><h2 className="card-h">Mine with a bot</h2><p className="muted">Bots open once HLO is live on this network.</p></section>;
  return (
    <>
      <section className="card">
        <h2 className="card-h">Mine with a bot</h2>
        <p>{BOT_INTRO}</p>
        <div className="stat"><span className="k">Network</span><span className="v">{cfg.network}</span></div>
        <div className="stat"><span className="k">HLO builder fee</span><span className="v">{builderFeeText}</span></div>
        <div className="stat stat-wrap"><span className="k">Builder address</span><span className="v break">{cfg.builder}</span></div>
      </section>
      <section className="card">
        <h2 className="card-h">Set up</h2>
        <ol className="bot-steps">
          {botSteps({ origin }).map((s) => (
            <li key={s.title}><strong>{s.title}</strong><p className="muted">{s.text}</p></li>
          ))}
        </ol>
        <p><a href={apiPageUrl(cfg.network)} target="_blank" rel="noreferrer">Hyperliquid's API page</a></p>
        <pre className="code-block">{builderField(cfg.builder)}</pre>
      </section>
      <section className="card">
        <h2 className="card-h">Sample bot</h2>
        <p className="muted">{BOT_SAMPLE_TEXT}</p>
        <p><a href={BOT_FILE} download>Download hlo-bot.mjs</a></p>
        <pre className="code-block">{botCommands(origin)}</pre>
      </section>
      <section className="card">
        <h2 className="card-h">The rules</h2>
        <ul className="bot-rules">{BOT_RULES.map((r) => <li key={r}>{r}</li>)}</ul>
        <p><a href={TERMS_URL} target="_blank" rel="noreferrer">Hyperliquid's Terms</a></p>
      </section>
    </>
  );
}
