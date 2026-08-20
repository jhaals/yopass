import React, { useEffect, useState } from 'react';
import Layout from '@theme/Layout';
import Head from '@docusaurus/Head';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; token: string; company: string; expiresAt: string };

export default function TrialRedeem(): React.ReactElement {
  const { siteConfig } = useDocusaurusContext();
  const redeemUrl = (siteConfig.customFields?.trialRedeemUrl as string) ?? '';

  const [state, setState] = useState<State>({ status: 'loading' });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      setState({ status: 'error', message: 'This trial link is missing its token.' });
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(redeemUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const data = await resp.json();
        if (cancelled) return;
        if (!resp.ok || data.error) {
          setState({
            status: 'error',
            message: data.error ?? 'This trial link is invalid or has expired.',
          });
          return;
        }
        setState({
          status: 'ready',
          token: data.token,
          company: data.company ?? '',
          expiresAt: data.expires_at ?? '',
        });
      } catch {
        if (!cancelled) {
          setState({
            status: 'error',
            message: 'Could not reach the trial service. Please try again.',
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [redeemUrl]);

  async function copy(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — user can select manually */
    }
  }

  return (
    <Layout title="Your Yopass trial license — Yopass" noFooter>
      <Head>
        <meta name="description" content="Activate your 7-day Yopass Business trial." />
        <meta name="robots" content="noindex" />
      </Head>

      <div className="mesh-bg min-h-screen bg-[#fafbfc] flex flex-col">
        <main className="flex-1 flex items-center justify-center px-6 py-16">
          <div className="glass-card rounded-3xl p-8 md:p-12 max-w-lg w-full">
            {state.status === 'loading' && (
              <div className="text-center py-8">
                <div className="mx-auto mb-4 w-8 h-8 rounded-full border-2 border-gray-200 border-t-brand-blue animate-spin" />
                <p className="text-gray-500">Activating your trial…</p>
              </div>
            )}

            {state.status === 'error' && (
              <div className="text-center">
                <h1 className="text-2xl font-bold tracking-tight mb-3">
                  Trial link problem
                </h1>
                <p className="text-gray-500 leading-relaxed mb-8">{state.message}</p>
                <a
                  href="/trial"
                  className="inline-block gradient-brand text-white px-7 py-3 rounded-full text-sm font-semibold hover:opacity-90 transition-opacity shadow-lg shadow-brand-blue/20"
                >
                  Request a new trial
                </a>
              </div>
            )}

            {state.status === 'ready' && (
              <div>
                <h1 className="text-2xl md:text-3xl font-bold tracking-tight mb-1 gradient-text">
                  Your trial license
                </h1>
                <p className="text-sm text-gray-500 mb-6">
                  {state.company ? <>Licensed to {state.company}. </> : null}
                  Valid until {state.expiresAt}. We've also emailed you a copy.
                </p>

                <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                  License key
                </label>
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 mb-3">
                  <code className="block font-mono text-xs text-gray-700 break-all leading-relaxed">
                    {state.token}
                  </code>
                </div>
                <button
                  onClick={() => copy(state.token)}
                  className="w-full py-3 rounded-full gradient-brand text-white text-sm font-semibold hover:opacity-90 transition-opacity shadow-lg shadow-brand-blue/20 mb-8"
                >
                  {copied ? 'Copied ✓' : 'Copy license key'}
                </button>

                <div className="text-left space-y-3">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                    Next steps
                  </p>
                  {[
                    <>
                      Set{' '}
                      <code className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">
                        LICENSE_KEY
                      </code>{' '}
                      to this value in your deployment environment
                    </>,
                    <>
                      Follow the{' '}
                      <a
                        href="/docs"
                        className="text-brand-blue hover:underline font-medium"
                      >
                        installation docs
                      </a>{' '}
                      to deploy your instance
                    </>,
                  ].map((step, i) => (
                    <div key={i} className="flex gap-3 items-start">
                      <span className="shrink-0 w-5 h-5 rounded-full gradient-brand text-white text-xs font-bold flex items-center justify-center mt-0.5">
                        {i + 1}
                      </span>
                      <p className="text-sm text-gray-600">{step}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </Layout>
  );
}
