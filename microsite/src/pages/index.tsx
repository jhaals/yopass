import React, { useEffect, useState } from 'react';
import Layout from '@theme/Layout';
import Head from '@docusaurus/Head';
import EncryptionTerminal from '../components/EncryptionTerminal';
import CheckoutModal from '../components/CheckoutModal';

export default function Home(): React.ReactElement {
  const [checkoutOpen, setCheckoutOpen] = useState(false);

  useEffect(() => {
    const reveals = document.querySelectorAll<HTMLElement>('.reveal');
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry, i) => {
          if (entry.isIntersecting) {
            (entry.target as HTMLElement).style.transitionDelay = `${i * 0.08}s`;
            entry.target.classList.add('visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    );
    reveals.forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <Layout title="Share Secrets Securely | End-to-End Encrypted Secret Sharing" noFooter>
      <Head>
        <meta name="description" content="Stop sharing passwords in Slack and email. Yopass encrypts secrets in your browser and generates one-time links that auto-expire. Open source, no accounts needed." />
        <meta property="og:title" content="Yopass — Share Secrets Securely" />
        <meta property="og:description" content="Stop sharing passwords in Slack and email. Yopass encrypts secrets in your browser and generates one-time links that auto-expire." />
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://yopass.se/" />
        <meta property="og:image" content="https://yopass.se/og-image.png" />
        <meta property="og:site_name" content="Yopass" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Yopass — Share Secrets Securely" />
        <meta name="twitter:description" content="Stop sharing passwords in Slack and email. Yopass encrypts secrets in your browser and generates one-time links that auto-expire." />
        <meta name="twitter:image" content="https://yopass.se/og-image.png" />
        <script type="application/ld+json">{JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'SoftwareApplication',
          name: 'Yopass',
          description: 'Open source end-to-end encrypted secret sharing with self-destructing one-time links.',
          applicationCategory: 'SecurityApplication',
          operatingSystem: 'Web',
          url: 'https://yopass.se',
          logo: 'https://yopass.se/logo/yopass.svg',
          author: { '@type': 'Person', name: 'Johan Haals', url: 'https://github.com/jhaals' },
          offers: [
            { '@type': 'Offer', name: 'Open Source', price: '0', priceCurrency: 'USD', description: 'Free forever. Self-hosted, end-to-end encryption, one-time secret links.' },
            { '@type': 'Offer', name: 'Business License', price: '149', priceCurrency: 'EUR', description: 'Secret requests, read receipts, webhooks, custom branding, higher upload limits. Billed annually.' },
          ],
          featureList: ['End-to-end encryption', 'Self-destructing links', 'One-time downloads', 'No account required', 'Open source', 'Docker and Kubernetes support'],
          isAccessibleForFree: true,
          license: 'https://github.com/jhaals/yopass/blob/master/LICENSE',
        })}</script>
      </Head>

      {/* ── HERO ── */}
      <section className="relative pt-12 pb-24 md:pt-20 md:pb-32 overflow-hidden">
        <div className="absolute inset-0 mesh-bg" />
        <div className="absolute inset-0 dot-grid opacity-25" />

        <div className="relative max-w-6xl mx-auto px-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-12 lg:gap-20 items-center">

            {/* Left: text */}
            <div>
              <p className="code-accent text-brand-teal mb-5 animate-fade-up">Open-source secret sharing</p>
              <h1 className="text-6xl md:text-7xl font-bold tracking-tight leading-[1.06] mb-6 animate-fade-up delay-100">
                Share Secrets<br />
                <span className="text-brand-green">Securely</span>
              </h1>
              <p className="text-xl text-gray-500 leading-relaxed max-w-lg mb-10 animate-fade-up delay-200">
                Stop sharing passwords in Slack, email, and ticket systems. Yopass encrypts secrets in your browser and generates one-time links that auto-expire.
              </p>

              <div className="flex flex-wrap gap-4 mb-14 animate-fade-up delay-300">
                <a
                  href="https://share.yopass.se"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-7 py-3.5 border-2 border-gray-200 rounded-full text-sm font-semibold text-gray-700 hover:border-gray-400 transition-colors"
                >
                  Try the Demo
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
                <a
                  href="#pricing"
                  className="inline-flex items-center gap-2 gradient-brand text-white px-7 py-3.5 rounded-full text-sm font-semibold hover:opacity-90 transition-opacity shadow-lg shadow-brand-blue/20"
                >
                  Get Started
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
                </a>
              </div>

              <div className="animate-fade-up delay-400">
                <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Trusted by engineers at</p>
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mt-2.5">
                  <span className="text-sm font-bold text-gray-500">Spotify</span>
                  <span className="w-1 h-1 rounded-full bg-gray-300" />
                  <span className="text-sm font-bold text-gray-500">Doddle</span>
                  <span className="w-1 h-1 rounded-full bg-gray-300" />
                  <span className="text-sm font-bold text-gray-500">Gumtree Australia</span>
                </div>
              </div>
            </div>

            {/* Right: terminal animation */}
            <div className="hidden md:block animate-fade-in delay-300">
              <EncryptionTerminal />
            </div>

          </div>
        </div>
      </section>

      {/* ── PROBLEM + SOLUTION (compressed) ── */}
      <section className="py-20 md:py-28 bg-white relative">
        <div className="max-w-6xl mx-auto px-6">
          <div className="reveal max-w-3xl mx-auto text-center mb-14 md:mb-16">
            <p className="code-accent text-brand-teal mb-4">The problem</p>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight mb-5">
              Secrets don't belong in your chat history
            </h2>
            <p className="text-gray-500 text-lg leading-relaxed">
              Passwords and API keys shared over Slack, email, and tickets sit in plaintext — searchable forever, readable by anyone with access. Yopass replaces that with three simple steps.
            </p>
          </div>

          <div className="reveal grid md:grid-cols-3 gap-6">
            {[
              {
                n: '01', title: 'Encrypt',
                icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />,
                desc: 'Type or paste your secret. It\'s encrypted in your browser with OpenPGP before anything leaves your machine.',
              },
              {
                n: '02', title: 'Share',
                icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />,
                desc: 'Get a unique one-time link. Send it through any channel — the decryption key never touches the server.',
              },
              {
                n: '03', title: 'Expire',
                icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />,
                desc: 'The secret self-destructs after being viewed — or when the timer runs out. Nothing persists.',
              },
            ].map(({ n, title, icon, desc }) => (
              <div key={n} className="feature-card glass-card rounded-2xl p-6">
                <div className="feature-icon w-11 h-11 rounded-xl bg-tint-green flex items-center justify-center mb-5">
                  <svg className="w-5 h-5 text-brand-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">{icon}</svg>
                </div>
                <h3 className="font-bold text-lg mb-1.5">{n}. {title}</h3>
                <p className="text-sm text-gray-500 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FOR BUSINESS ── */}
      <section className="py-20 md:py-28 dark-section">
        <div className="max-w-6xl mx-auto px-6">
          <div className="reveal flex flex-col md:flex-row md:items-end justify-between gap-6 mb-12 md:mb-16">
            <div className="max-w-2xl">
              <p className="code-accent text-emerald-400 mb-4">For teams &amp; business</p>
              <h2 className="text-3xl md:text-5xl font-bold tracking-tight text-white/95">
                Advanced security governance
              </h2>
            </div>
            <p className="text-white/55 text-lg max-w-sm">
              A clear audit trail and secure secret workflows across your entire organization — unlocked with a business license.
            </p>
          </div>

          <div className="reveal grid md:grid-cols-12 gap-6">
            {/* Secret Requests — wide */}
            <a
              href="/docs/secret-requests"
              className="dark-card group no-underline hover:no-underline md:col-span-8 rounded-2xl p-7 relative overflow-hidden transition-transform hover:-translate-y-1"
            >
              <div className="relative z-10 max-w-md">
                <div className="w-11 h-11 rounded-xl bg-brand-green/15 flex items-center justify-center mb-5">
                  <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /></svg>
                </div>
                <h3 className="text-xl font-bold mb-2 text-white/95">Secret Requests</h3>
                <p className="text-sm text-white/55 leading-relaxed">
                  Receive credentials securely from vendors or clients who don't use Yopass. Send a request link, they upload the secret, and you receive it encrypted.
                </p>
              </div>
              <svg className="absolute right-4 bottom-4 w-40 h-40 text-white/[0.04] group-hover:text-white/[0.07] transition-colors pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /></svg>
            </a>

            {/* Read Receipts */}
            <a
              href="/docs/read-receipts"
              className="dark-card group no-underline hover:no-underline md:col-span-4 rounded-2xl p-7 transition-transform hover:-translate-y-1"
            >
              <div className="w-11 h-11 rounded-xl bg-brand-green/15 flex items-center justify-center mb-5">
                <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
              </div>
              <h3 className="text-xl font-bold mb-2 text-white/95">Read Receipts</h3>
              <p className="text-sm text-white/55 leading-relaxed">
                Know exactly when a secret is opened. Get notified by email or webhook the moment a one-time link is decrypted.
              </p>
            </a>

            {/* Webhooks */}
            <a
              href="/docs/webhooks"
              className="dark-card group no-underline hover:no-underline md:col-span-6 rounded-2xl p-7 transition-transform hover:-translate-y-1"
            >
              <div className="w-11 h-11 rounded-xl bg-brand-green/15 flex items-center justify-center mb-5">
                <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
              </div>
              <h3 className="text-xl font-bold mb-2 text-white/95">Webhooks</h3>
              <p className="text-sm text-white/55 leading-relaxed">
                Push security events into your SOC or dev workflows. Trigger automated actions when secrets are created, requested, or accessed.
              </p>
            </a>

            {/* OpenID Connect */}
            <a
              href="/docs/openid-connect"
              className="dark-card group no-underline hover:no-underline md:col-span-6 rounded-2xl p-7 transition-transform hover:-translate-y-1"
            >
              <div className="w-11 h-11 rounded-xl bg-brand-green/15 flex items-center justify-center mb-5">
                <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" /></svg>
              </div>
              <h3 className="text-xl font-bold mb-2 text-white/95">OpenID Connect Sign-In</h3>
              <p className="text-sm text-white/55 leading-relaxed">
                Put secret creation behind single sign-on. Require users to authenticate through your OpenID Connect provider before sharing.
              </p>
            </a>

            {/* Audit Logs — with code readout */}
            <a
              href="/docs/audit-logging"
              className="dark-card group no-underline hover:no-underline md:col-span-12 rounded-2xl p-7 flex flex-col transition-transform hover:-translate-y-1"
            >
              <div className="w-11 h-11 rounded-xl bg-brand-green/15 flex items-center justify-center mb-5">
                <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7l2 2 4-4" /></svg>
              </div>
              <h3 className="text-xl font-bold mb-2 text-white/95">Audit Logs</h3>
              <p className="text-sm text-white/55 leading-relaxed mb-5">
                Keep a non-repudiable record of sharing activity for compliance — who requested what and when, without ever exposing the secrets themselves.
              </p>
              <div className="mt-auto font-mono text-xs rounded-xl bg-black/25 border border-white/10 p-4 text-emerald-300/90">
                <div className="flex justify-between gap-3 text-white/40 mb-1.5">
                  <span>2026-06-17T14:32:01Z</span>
                  <span>secret.created</span>
                </div>
                <div className="text-white/70 break-all">{'{"outcome":"success","user_email":"user@example.com","client_ip":"203.0.113.42","secret_id":"e065107b78ac","one_time":true}'}</div>
              </div>
            </a>
          </div>
        </div>
      </section>

      {/* ── BUILT FOR SECURITY ── */}
      <section className="py-20 md:py-28 relative">
        <div className="absolute inset-0 mesh-bg opacity-70" />
        <div className="relative max-w-6xl mx-auto px-6">
          <div className="reveal text-center mb-14 md:mb-16">
            <p className="code-accent text-brand-teal mb-4">Built for security</p>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight mb-4">Simple enough to actually use</h2>
            <p className="text-gray-500 text-lg max-w-2xl mx-auto">
              Designed so that following best security practices becomes the path of least resistance.
            </p>
          </div>

          <div className="reveal grid md:grid-cols-3 gap-8 md:gap-10">
            {[
              {
                title: 'End-to-End Encryption',
                desc: 'Encryption and decryption happen locally in your browser. The server never sees your plaintext data.',
                icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />,
              },
              {
                title: 'No Accounts Needed',
                desc: 'No sign-ups, no tracking, no cookies. Only the encrypted secret is stored — nothing else.',
                icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />,
              },
              {
                title: 'Open Source',
                desc: 'Audit the code, contribute features, or self-host with full confidence on your own infrastructure.',
                icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />,
              },
            ].map(({ title, desc, icon }) => (
              <div key={title} className="flex gap-4">
                <div className="w-11 h-11 shrink-0 rounded-xl bg-tint-green flex items-center justify-center">
                  <svg className="w-5 h-5 text-brand-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">{icon}</svg>
                </div>
                <div>
                  <h3 className="font-bold text-lg mb-1.5">{title}</h3>
                  <p className="text-sm text-gray-500 leading-relaxed">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── PRICING ── */}
      <section id="pricing" className="py-20 md:py-28 bg-[#eaf6fb]">
        <div className="max-w-6xl mx-auto px-6">
          <div className="reveal text-center mb-16">
            <p className="code-accent text-brand-teal mb-4">Pricing</p>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight mb-4">Free to start. Scale when ready.</h2>
            <p className="text-gray-500 text-lg max-w-xl mx-auto">
              Yopass is open source and free to self-host, always. The business license adds branding and higher limits — still running on your own infrastructure, because that's what makes it truly secure.
            </p>
          </div>

          <div className="reveal grid md:grid-cols-2 gap-6 max-w-4xl mx-auto">
            {/* Open Source */}
            <div className="pricing-card glass-card rounded-2xl p-8 flex flex-col">
              <div className="mb-6">
                <h3 className="text-lg font-bold mb-1">Open Source</h3>
                <div className="flex items-baseline gap-1">
                  <span className="text-4xl font-bold tracking-tight">Free</span>
                  <span className="text-gray-400 text-sm">self-hosted, forever</span>
                </div>
              </div>

              <ul className="space-y-3 mb-8 flex-1">
                {['End-to-end encryption', 'One-time secret links', 'File upload support', 'Configurable expiration (1h / 1d / 1w)', 'Redis or Memcached backend', 'Docker + Kubernetes deployment', 'Community support via GitHub'].map(item => (
                  <li key={item} className="flex items-start gap-3 text-sm text-gray-600">
                    <svg className="w-5 h-5 text-brand-green shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                    {item}
                  </li>
                ))}
              </ul>

              <a
                href="https://github.com/jhaals/yopass"
                target="_blank"
                rel="noopener noreferrer"
                className="block text-center py-3.5 rounded-full border-2 border-gray-200 text-sm font-semibold text-gray-700 hover:border-gray-400 transition-colors"
              >
                View on GitHub
              </a>
            </div>

            {/* Business License */}
            <div className="pricing-card pricing-featured gradient-brand relative rounded-2xl flex flex-col">
              <div className="relative bg-white rounded-[14px] m-[2px] p-8 flex flex-col flex-1">
                <div className="absolute -top-3.5 left-8">
                  <span className="gradient-brand text-white text-xs font-bold px-4 py-1.5 rounded-full">Recommended</span>
                </div>

                <div className="mb-6">
                  <h3 className="text-lg font-bold mb-1">Business License</h3>
                  <div className="flex items-baseline gap-1">
                    <span className="text-4xl font-bold tracking-tight text-brand-blue">€149</span>
                    <span className="text-gray-400 text-sm">/ year · self-hosted</span>
                  </div>
                </div>

                <p className="text-sm text-gray-500 mb-4">Everything in Open Source, plus:</p>

                <ul className="space-y-3 mb-8 flex-1">
                  {[
                    { label: 'Custom branding & theming', href: '/docs/theming' },
                    { label: 'Higher upload size limits' },
                    { label: 'OpenID Connect authentication', href: '/docs/openid-connect' },
                    { label: 'Audit logging', href: '/docs/audit-logging' },
                    { label: 'Secret requests — receive secrets securely', href: '/docs/secret-requests' },
                    { label: 'Read receipts — know when secrets are opened', href: '/docs/read-receipts' },
                    { label: 'Webhooks — push events to your systems', href: '/docs/webhooks' },
                  ].map(item => (
                    <li key={item.label} className="flex items-start gap-3 text-sm text-gray-600">
                      <svg className="w-5 h-5 text-brand-blue shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                      {item.href ? <a href={item.href} className="hover:underline">{item.label}</a> : item.label}
                    </li>
                  ))}
                </ul>

                <button
                  onClick={() => setCheckoutOpen(true)}
                  className="w-full text-center py-3.5 rounded-full gradient-brand text-white text-sm font-semibold hover:opacity-90 transition-opacity shadow-lg shadow-brand-blue/20 cursor-pointer"
                >
                  Get Started
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="py-14 border-t border-gray-100 bg-white/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-6">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
            <div>
              <img src="/logo/Yopass horizontal.svg" alt="Yopass" className="h-6 mb-3" width={102} height={24} />
              <p className="text-sm text-gray-400">Created by Johan Haals · © {new Date().getFullYear()} Yopass</p>
            </div>
            <div className="flex flex-wrap items-center gap-6">
              {[
                { label: 'GitHub', href: 'https://github.com/jhaals/yopass', external: true },
                { label: 'Documentation', href: '/docs/intro', external: false },
                { label: 'Demo', href: 'https://share.yopass.se', external: true },
                { label: 'Contact', href: 'mailto:johan@yopass.se', external: false },
                { label: 'Privacy Policy', href: '/privacy', external: false },
              ].map(({ label, href, external }) => (
                <a
                  key={label}
                  href={href}
                  {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                  className="text-sm text-gray-500 hover:text-gray-900 transition-colors"
                >
                  {label}
                </a>
              ))}
            </div>
          </div>
        </div>
      </footer>

      <CheckoutModal isOpen={checkoutOpen} onClose={() => setCheckoutOpen(false)} />
    </Layout>
  );
}
