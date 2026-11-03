import { useEffect, useState } from "react";
import { useConfig } from "../../config/context";
import { introCards, INTRO_TITLE, type IntroImage } from "../../rewards/intro";
import { POP_ODDS } from "../../rewards/odds";
import { Modal } from "../Modal";
import claim from "./claim.webp";
import mining from "./mining.webp";
import start from "./start.webp";
import vault from "./vault.webp";

const IMAGES: Record<IntroImage, string> = { mining, vault, claim, start };

/** The first-visit intro: one card at a time, Skip or Next; the last card's button is Start. Any way out counts as seen. */
export function IntroModal({ onClose }: { onClose(): void }) {
  const cards = introCards(POP_ODDS[useConfig().hyperEvmChainId]);
  const [i, setI] = useState(0);
  // Fetch the other images now, so Next shows the next card at once.
  useEffect(() => {
    for (const src of Object.values(IMAGES)) new Image().src = src;
  }, []);
  const card = cards[i];
  const last = i === cards.length - 1;
  return (
    <Modal title={INTRO_TITLE} onClose={onClose} className="intro">
      <img className="intro-img" src={IMAGES[card.image]} alt={card.alt} width={1200} height={675} />
      <div className="intro-foot">
        <span className="intro-dots" role="img" aria-label={`Card ${i + 1} of ${cards.length}`}>
          {cards.map((c, j) => <span key={c.image} className={j === i ? "on" : undefined} />)}
        </span>
        <span className="intro-actions">
          {!last && <button className="btn" onClick={onClose}>Skip</button>}
          <button className="btn primary" onClick={last ? onClose : () => setI(i + 1)}>{last ? "Start" : "Next"}</button>
        </span>
      </div>
    </Modal>
  );
}
