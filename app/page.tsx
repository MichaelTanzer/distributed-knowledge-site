export default function Home() {
  return (
    <main className="landing-frame">
      <section className="title-stack" aria-label="Distributed Knowledge">
        <h1 className="name">
          <span>Distributed</span>
          <span>Knowledge</span>
        </h1>
        <p className="tagline">Reliability, contradiction, and source-chain evaluation systems.</p>
      </section>
      <section className="mark-stack" aria-hidden="true">
        <div className="glyph">
          <svg viewBox="0 0 500 500" role="img">
            <defs>
              <linearGradient id="spiralGold" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#f1d27a" />
                <stop offset="52%" stopColor="#d0ad56" />
                <stop offset="100%" stopColor="#8a6a2a" />
              </linearGradient>
            </defs>
            <circle className="compass-ring faint" cx="250" cy="250" r="205" />
            <circle className="compass-ring" cx="250" cy="250" r="158" />
            <path className="map-halo" d="M126 128h248v244H126z" />
            <path className="map-grid" d="M150 160c54 20 102 21 151 0 23-9 45-11 70-3M151 225c51 16 96 14 142-5 29-13 55-12 79 1M151 294c46-11 91-8 137 12 29 12 58 12 86 0" />
            <path className="compass-star" d="M250 82l39 128 129 40-129 40-39 128-40-128-128-40 128-40z" />
            <path className="compass-star alt" d="M250 145l27 80 78 25-78 25-27 80-25-80-80-25 80-25z" />
            <path className="compass-axis" d="M250 62v376M62 250h376" />
            <path className="graph-guide" d="M126 340c61-98 136-145 248-162" />
            <path className="graph-edge" d="M132 337c42-61 87-95 139-110 38-11 73-30 103-57" />
            <path className="graph-edge secondary" d="M170 204c38 44 73 63 109 58 28-4 56 7 86 33" />
            <circle className="graph-node" cx="132" cy="337" r="9" />
            <circle className="graph-node" cx="271" cy="227" r="8" />
            <circle className="graph-node dark" cx="374" cy="170" r="7" />
            <circle className="graph-node dark" cx="365" cy="295" r="6" />
          </svg>
        </div>
      </section>
    </main>
  );
}
