export default function Home() {
  const originalMark = `
      <svg viewBox="0 0 640 640" role="img" aria-label="Abstract compass rose knowledge map">
        <defs>
          <linearGradient id="spiralGold" x1="80" y1="40" x2="560" y2="590" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#f4d976" />
            <stop offset="0.48" stop-color="#c89a31" />
            <stop offset="1" stop-color="#805314" />
          </linearGradient>
        </defs>

        <ellipse class="map-halo" cx="322" cy="328" rx="282" ry="250" />
        <polygon class="map-plane" points="82,402 194,122 548,188 520,514 172,558" />
        <polygon class="map-plane" points="126,222 418,76 584,344 288,504" opacity="0.42" />
        <polygon class="map-plane" points="72,306 334,150 600,278 466,596 156,486" opacity="0.30" />

        <path class="map-grid" d="M82 402 L548 188 M172 558 L418 76 M194 122 L520 514 M126 222 L584 344 M72 306 L600 278" />
        <path class="map-grid" d="M126 358 L456 118 L584 344 M214 520 L302 116 L600 278 M94 454 L320 320 L474 560" />
        <path class="map-vector light" d="M22 246 C132 172 262 142 390 172 S572 288 632 382" />
        <path class="map-vector light" d="M34 470 C150 382 300 332 476 352 S590 394 634 432" />
        <path class="map-vector light" d="M84 82 C212 132 288 198 352 322 S482 506 620 584" opacity="0.70" />
        <path class="map-vector" d="M72 238 C178 126 308 90 488 128" />
        <path class="map-vector" d="M456 42 L398 604" opacity="0.58" />
        <path class="map-vector" d="M50 536 L300 166 L612 218" opacity="0.58" />
        <path class="map-vector" d="M176 58 L592 524" opacity="0.44" />

        <g transform="translate(320 320)">
          <circle class="compass-ring faint" r="246" />
          <circle class="compass-ring" r="194" />
          <circle class="compass-ring faint" r="132" />
          <circle class="compass-ring" r="54" />

          <path class="compass-axis" d="M0 -278 L0 278 M-278 0 L278 0 M-196 -196 L196 196 M-196 196 L196 -196" />
          <path class="compass-axis gold" d="M0 -276 L18 -74 L0 -38 L-18 -74 Z" />
          <path class="compass-axis gold" d="M276 0 L74 18 L38 0 L74 -18 Z" />
          <path class="compass-axis gold" d="M0 276 L-18 74 L0 38 L18 74 Z" />
          <path class="compass-axis gold" d="M-276 0 L-74 -18 L-38 0 L-74 18 Z" />

          <polygon class="compass-star" points="0,-250 28,-72 0,-28 -28,-72" />
          <polygon class="compass-star alt" points="250,0 72,28 28,0 72,-28" />
          <polygon class="compass-star" points="0,250 -28,72 0,28 28,72" />
          <polygon class="compass-star alt" points="-250,0 -72,-28 -28,0 -72,28" />

          <polygon class="compass-star alt" points="150,-150 48,-34 30,-4 34,-48" opacity="0.84" />
          <polygon class="compass-star" points="150,150 34,48 4,30 48,34" opacity="0.70" />
          <polygon class="compass-star alt" points="-150,150 -48,34 -30,4 -34,48" opacity="0.84" />
          <polygon class="compass-star" points="-150,-150 -34,-48 -4,-30 -48,-34" opacity="0.70" />
        </g>

        <path class="graph-edge secondary" d="M320 70 C250 160 228 232 320 320 C412 408 388 494 320 570" opacity="0.36" />
        <path class="graph-edge secondary" d="M70 320 C166 256 238 228 320 320 C402 412 488 392 570 320" opacity="0.42" />
        <path class="graph-edge" d="M320 320 L258 198 L320 70 M320 320 L444 238 L570 320 M320 320 L388 454 L320 570 M320 320 L198 382 L70 320" opacity="0.82" />
        <path class="graph-edge secondary" d="M258 198 L150 142 L96 238 M444 238 L520 154 L598 248 M388 454 L486 528 L404 616 M198 382 L94 450 L150 562" />
        <path class="graph-edge secondary" d="M150 142 L320 320 L520 154 M96 238 L198 382 L404 616 M598 248 L444 238 L486 528 M150 562 L388 454 L70 320" opacity="0.50" />

        <g>
          <circle class="graph-node core" cx="320" cy="320" r="11" />
          <circle class="graph-node" cx="320" cy="70" r="7" />
          <circle class="graph-node" cx="570" cy="320" r="7" />
          <circle class="graph-node" cx="320" cy="570" r="7" />
          <circle class="graph-node" cx="70" cy="320" r="7" />
          <circle class="graph-node dark" cx="258" cy="198" r="4.8" />
          <circle class="graph-node dark" cx="444" cy="238" r="4.8" />
          <circle class="graph-node dark" cx="388" cy="454" r="4.8" />
          <circle class="graph-node dark" cx="198" cy="382" r="4.8" />
          <circle class="graph-node" cx="150" cy="142" r="5.5" />
          <circle class="graph-node" cx="96" cy="238" r="5.2" />
          <circle class="graph-node" cx="520" cy="154" r="5.5" />
          <circle class="graph-node" cx="598" cy="248" r="5.2" />
          <circle class="graph-node" cx="486" cy="528" r="5.5" />
          <circle class="graph-node" cx="404" cy="616" r="5.2" />
          <circle class="graph-node" cx="94" cy="450" r="5.5" />
          <circle class="graph-node" cx="150" cy="562" r="5.2" />
        </g>
      </svg>`;

  return (
    <main className="landing-frame">
      <section className="title-stack" aria-label="Distributed Knowledge">
        <h1 className="name">
          <span>Distributed</span>
          <span>Knowledge</span>
        </h1>
        <p className="tagline">Agent research for national security-grade reasoning systems</p>
      </section>
      <section className="mark-stack" aria-label="Distributed Knowledge mark">
        <div className="glyph" aria-hidden="true" dangerouslySetInnerHTML={{ __html: originalMark }} />
      </section>
    </main>
  );
}
