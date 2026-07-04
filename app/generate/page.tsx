'use client';

import { FormEvent, useState } from 'react';

type GenerateState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; message: string; deliveryId?: string }
  | { status: 'error'; message: string };

export default function GeneratePage() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<GenerateState>({ status: 'idle' });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: 'loading' });
    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? 'Generation failed');
      }
      setState({
        status: 'success',
        message: payload.message ?? 'Generation request accepted.',
        deliveryId: payload.deliveryId
      });
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : 'Generation failed' });
    }
  }

  return (
    <main className="generate-shell">
      <form className="generate-form" onSubmit={submit}>
        <input
          aria-label="Delivery email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="email"
          required
        />
        <button disabled={state.status === 'loading'} type="submit">
          {state.status === 'loading' ? 'Generating…' : 'Generate'}
        </button>
        {state.status === 'success' && <p className="notice success">{state.message}</p>}
        {state.status === 'error' && <p className="notice error">{state.message}</p>}
      </form>
    </main>
  );
}
