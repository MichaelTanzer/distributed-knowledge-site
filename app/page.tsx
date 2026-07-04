import Link from 'next/link';

export default function Home() {
  return (
    <main className="home">
      <section>
        <p className="eyebrow">Synthetic intelligence infrastructure</p>
        <h1>Distributed<br />Knowledge</h1>
        <p className="tagline">Reliability, contradiction, and source-chain evaluation systems.</p>
        <Link className="access" href="/generate">Generate an info-pack</Link>
      </section>
      <div className="mark" aria-hidden="true">⌖</div>
    </main>
  );
}
