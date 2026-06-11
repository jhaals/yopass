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
            { '@type': 'Offer', name: 'Business License', price: '149', priceCurrency: 'EUR', description: 'Secret requests, custom branding, higher upload limits. Billed annually.' },
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

      {/* ── WHY YOPASS ── */}
      <section className="py-20 md:py-28 dark-section">
        <div className="max-w-6xl mx-auto px-6">
          <div className="reveal max-w-4xl mx-auto text-center">
            <p className="code-accent text-emerald-400 mb-4">The problem</p>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight mb-6 text-white/95">
              Secrets don't belong<br className="hidden md:block" /> in your chat history
            </h2>
            <p className="text-white/60 text-lg md:text-xl leading-relaxed max-w-2xl mx-auto">
              Every day, passwords and API keys are shared through Slack, email, and ticket systems — stored in plaintext, searchable forever, accessible to anyone with access to the channel. Yopass gives you a better way.
            </p>
          </div>

          <div className="reveal mt-16 grid md:grid-cols-3 gap-6">
            {[
              {
                icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />,
                title: 'Slack messages',
                desc: 'Passwords pasted in channels, indexed and searchable by everyone in the workspace.',
              },
              {
                icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />,
                title: 'Email threads',
                desc: 'Credentials forwarded and quoted, living forever in inboxes and backups.',
              },
              {
                icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />,
                title: 'Ticket systems',
                desc: 'API keys dropped into Jira or ServiceNow, visible to every team member with project access.',
              },
            ].map(({ icon, title, desc }) => (
              <div key={title} className="dark-card rounded-2xl p-6">
                <div className="w-10 h-10 rounded-xl bg-red-500/15 flex items-center justify-center mb-4">
                  <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">{icon}</svg>
                </div>
                <p className="font-semibold text-white/90 mb-1">{title}</p>
                <p className="text-sm text-white/55">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ── */}
      <section className="py-20 md:py-28 bg-white">
        <div className="max-w-6xl mx-auto px-6">
          <div className="reveal text-center mb-16">
            <p className="code-accent text-brand-teal mb-4">How it works</p>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight">Three steps. Zero plaintext.</h2>
          </div>

          <div className="reveal grid md:grid-cols-3 gap-8 md:gap-12 relative">
            <div className="hidden md:block absolute top-16 left-[calc(33.33%+12px)] right-[calc(33.33%+12px)]">
              <div className="step-connector" />
            </div>

            {[
              {
                n: '01', title: 'Encrypt',
                icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />,
                desc: 'Type or paste your secret. It\'s encrypted in your browser using OpenPGP before anything leaves your machine.',
              },
              {
                n: '02', title: 'Share',
                icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />,
                desc: 'Get a unique one-time link. Send it through any channel — the decryption key never touches the server.',
              },
              {
                n: '03', title: 'Auto-Expire',
                icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />,
                desc: 'The secret self-destructs after being viewed — or when the timer runs out. Nothing persists.',
              },
            ].map(({ n, title, icon, desc }) => (
              <div key={n} className="text-center md:text-left">
                <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl gradient-brand mb-6">
                  <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">{icon}</svg>
                </div>
                <p className="code-accent text-gray-400 mb-2">Step {n}</p>
                <h3 className="text-xl font-bold mb-2">{title}</h3>
                <p className="text-gray-500 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section className="py-20 md:py-28 relative">
        <div className="absolute inset-0 mesh-bg opacity-70" />
        <div className="relative max-w-6xl mx-auto px-6">
          <div className="reveal text-center mb-16">
            <p className="code-accent text-brand-teal mb-4">Features</p>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight">
              Built for security,<br className="hidden md:block" /> designed for simplicity
            </h2>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
            {[
              {
                title: 'End-to-End Encryption',
                desc: 'Encryption and decryption happen locally in your browser. The server never sees your plaintext data.',
                icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />,
              },
              {
                title: 'Self-Destruction',
                desc: 'Secrets have a fixed lifetime and are automatically deleted after expiration. Choose 1 hour, 1 day, or 1 week.',
                icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />,
              },
              {
                title: 'One-Time Downloads',
                desc: 'Secrets can only be downloaded once, eliminating the risk of unauthorized repeat access.',
                icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />,
              },
              {
                title: 'Simple Sharing',
                desc: 'Generate a unique one-click link. The decryption key can optionally be shared via a separate channel.',
                icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />,
              },
              {
                title: 'No Accounts Needed',
                desc: 'No sign-ups, no tracking, no cookies. Only the encrypted secret is stored — nothing else.',
                icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />,
              },
              {
                title: 'Open Source',
                desc: 'Fully transparent. Audit the code, contribute features, or self-host with confidence on your own infrastructure.',
                icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />,
              },
            ].map(({ title, desc, icon }) => (
              <div key={title} className="reveal feature-card glass-card rounded-2xl p-7">
                <div className="feature-icon w-11 h-11 rounded-xl gradient-brand flex items-center justify-center mb-5">
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">{icon}</svg>
                </div>
                <h3 className="font-bold text-lg mb-2">{title}</h3>
                <p className="text-sm text-gray-500 leading-relaxed">{desc}</p>
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
