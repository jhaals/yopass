import React, { useState, type FormEvent } from 'react';
import Layout from '@theme/Layout';
import Head from '@docusaurus/Head';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

// The seven paid features, mirrored from the pricing section on the landing
// page. `id` is what we store in Supabase; `label` is what the user sees.
const FEATURES: { id: string; label: string }[] = [
  { id: 'theming', label: 'Custom branding & theming' },
  { id: 'upload-limits', label: 'Higher upload size limits' },
  { id: 'openid-connect', label: 'OpenID Connect authentication' },
  { id: 'audit-logging', label: 'Audit logging' },
  { id: 'secret-requests', label: 'Secret requests' },
  { id: 'read-receipts', label: 'Read receipts' },
  { id: 'webhooks', label: 'Webhooks' },
];

const inputClass =
  'w-full rounded-lg border border-gray-200 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/40 focus:border-brand-blue transition-colors';

export default function Trial(): React.ReactElement {
  const { siteConfig } = useDocusaurusContext();
  const trialUrl = (siteConfig.customFields?.trialUrl as string) ?? '';

  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [usingYopass, setUsingYopass] = useState<boolean | null>(null);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitLabel, setSubmitLabel] = useState('Start free trial →');
  const [done, setDone] = useState(false);

  const allSelected = FEATURES.every((f) => selected[f.id]);

  function toggle(id: string) {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function toggleAll() {
    if (allSelected) {
      setSelected({});
    } else {
      setSelected(Object.fromEntries(FEATURES.map((f) => [f.id, true])));
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    if (usingYopass === null) {
      setError('Please tell us whether you already use Yopass.');
      return;
    }
    if (!acceptedTerms) {
      setError('Please accept the terms of service to continue.');
      return;
    }

    setSubmitting(true);
    setSubmitLabel('Sending…');

    const features = FEATURES.filter((f) => selected[f.id]).map((f) => f.id);

    try {
      const resp = await fetch(trialUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          company_name: company.trim(),
          features,
          using_yopass: usingYopass,
          accepted_terms: acceptedTerms,
        }),
      });
      const data = await resp.json();
      if (!resp.ok || data.error) {
        setError(data.error ?? 'Something went wrong. Please try again.');
        setSubmitting(false);
        setSubmitLabel('Start free trial →');
        return;
      }
      setDone(true);
    } catch {
      setError('Could not connect to the trial service. Please try again.');
      setSubmitting(false);
      setSubmitLabel('Start free trial →');
    }
  }

  return (
    <Layout title="Start a free trial — Yopass" noFooter>
      <Head>
        <meta
          name="description"
          content="Try Yopass Business free for 7 days. No credit card required."
        />
      </Head>

      <div className="mesh-bg min-h-screen bg-[#fafbfc] flex flex-col">
        <main className="flex-1 flex items-center justify-center px-6 py-16">
          <div className="glass-card rounded-3xl p-8 md:p-12 max-w-lg w-full">
            {done ? (
              <div className="text-center">
                <div className="mb-6 flex justify-center">
                  <div className="w-14 h-14 rounded-full gradient-brand flex items-center justify-center">
                    <svg
                      className="w-7 h-7 text-white"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                      />
                    </svg>
                  </div>
                </div>
                <h1 className="text-2xl md:text-3xl font-bold tracking-tight mb-3 gradient-text">
                  Check your email
                </h1>
                <p className="text-gray-500 leading-relaxed mb-8">
                  We've sent a link to <span className="font-medium">{email.trim()}</span>.
                  Open it to activate your 7-day Yopass Business trial. If it
                  doesn't arrive within a few minutes, check your spam folder.
                </p>
                <a
                  href="/"
                  className="inline-block border-2 border-gray-200 text-gray-700 px-7 py-3 rounded-full text-sm font-semibold hover:border-gray-400 transition-colors"
                >
                  Back to Yopass
                </a>
              </div>
            ) : (
              <>
                <h1 className="text-2xl md:text-3xl font-bold tracking-tight mb-1">
                  Start a free trial
                </h1>
                <p className="text-sm text-gray-500 mb-8">
                  Try all Yopass Business features free for 7 days. No credit
                  card required — one trial per company.
                </p>

                <form noValidate className="space-y-5" onSubmit={handleSubmit}>
                  <div>
                    <label
                      htmlFor="tr-email"
                      className="block text-sm font-medium text-gray-700 mb-1"
                    >
                      Work Email
                    </label>
                    <input
                      id="tr-email"
                      type="email"
                      required
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className={inputClass}
                      placeholder="you@company.com"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="tr-company"
                      className="block text-sm font-medium text-gray-700 mb-1"
                    >
                      Company Name
                    </label>
                    <input
                      id="tr-company"
                      type="text"
                      required
                      autoComplete="organization"
                      value={company}
                      onChange={(e) => setCompany(e.target.value)}
                      className={inputClass}
                    />
                  </div>

                  <fieldset>
                    <legend className="block text-sm font-medium text-gray-700 mb-2">
                      Which features are you interested in?
                    </legend>

                    <label className="flex items-center gap-2.5 py-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleAll}
                        className="h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue/40"
                      />
                      <span className="text-sm font-semibold text-gray-800">
                        All of the above
                      </span>
                    </label>

                    <div className="mt-1 pl-1 grid grid-cols-1 sm:grid-cols-2 gap-x-4">
                      {FEATURES.map((f) => (
                        <label
                          key={f.id}
                          className="flex items-center gap-2.5 py-1.5 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={Boolean(selected[f.id])}
                            onChange={() => toggle(f.id)}
                            className="h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue/40"
                          />
                          <span className="text-sm text-gray-600">{f.label}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>

                  <fieldset>
                    <legend className="block text-sm font-medium text-gray-700 mb-2">
                      Are you using Yopass today?
                    </legend>
                    <div className="flex gap-3">
                      {[
                        { label: 'Yes', value: true },
                        { label: 'No', value: false },
                      ].map((opt) => {
                        const active = usingYopass === opt.value;
                        return (
                          <label
                            key={opt.label}
                            className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border cursor-pointer text-sm font-medium transition-colors ${
                              active
                                ? 'border-brand-blue bg-brand-blue/5 text-brand-blue'
                                : 'border-gray-200 text-gray-600 hover:border-gray-300'
                            }`}
                          >
                            <input
                              type="radio"
                              name="using-yopass"
                              className="sr-only"
                              checked={active}
                              onChange={() => setUsingYopass(opt.value)}
                            />
                            {opt.label}
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>

                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      required
                      checked={acceptedTerms}
                      onChange={(e) => setAcceptedTerms(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue/40"
                    />
                    <span className="text-sm text-gray-600">
                      I accept the{' '}
                      <a
                        href="/tos"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-brand-blue hover:underline font-medium"
                      >
                        terms of service
                      </a>
                      .
                    </span>
                  </label>

                  {error && <p className="text-sm text-red-600">{error}</p>}

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full py-3.5 rounded-full gradient-brand text-white text-sm font-semibold hover:opacity-90 transition-opacity shadow-lg shadow-brand-blue/20 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {submitLabel}
                  </button>
                </form>

                <p className="text-xs text-gray-400 mt-5 text-center">
                  Questions? Email{' '}
                  <a
                    href="mailto:johan@yopass.se"
                    className="underline hover:text-gray-600 transition-colors"
                  >
                    johan@yopass.se
                  </a>
                  .
                </p>
              </>
            )}
          </div>
        </main>
      </div>
    </Layout>
  );
}
