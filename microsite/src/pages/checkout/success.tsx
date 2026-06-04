import React from 'react';
import Layout from '@theme/Layout';
import Head from '@docusaurus/Head';

const ANIMATIONS = `
  .success-card { animation: cardIn 0.5s cubic-bezier(0.16, 1, 0.3, 1) both; }
  @keyframes cardIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }

  .check-circle {
    stroke-dasharray: 276; stroke-dashoffset: 276;
    animation: drawCircle 0.6s cubic-bezier(0.65, 0, 0.45, 1) 0.2s forwards;
  }
  @keyframes drawCircle { to { stroke-dashoffset: 0; } }

  .check-path {
    stroke-dasharray: 80; stroke-dashoffset: 80;
    animation: drawCheck 0.4s cubic-bezier(0.65, 0, 0.45, 1) 0.75s forwards;
  }
  @keyframes drawCheck { to { stroke-dashoffset: 0; } }

  .check-icon { animation: iconPop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) 1.1s both; }
  @keyframes iconPop { from { transform: scale(0.92); } to { transform: scale(1); } }

  .content-reveal { animation: fadeUpSmall 0.5s ease 0.5s both; }
  @keyframes fadeUpSmall { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
`;

export default function CheckoutSuccess(): React.ReactElement {
  return (
    <Layout title="License Purchased — Yopass" noFooter>
      <Head>
        <meta name="description" content="Your Yopass Business License is on its way." />
        <meta name="robots" content="noindex" />
        <style>{ANIMATIONS}</style>
      </Head>

      <div className="mesh-bg min-h-screen bg-[#fafbfc] flex flex-col">
        <main className="flex-1 flex items-center justify-center px-6 py-16">
          <div className="success-card glass-card rounded-3xl p-10 md:p-14 max-w-lg w-full text-center">

            <div className="check-icon mb-8 flex justify-center">
              <svg width="88" height="88" viewBox="0 0 96 96" fill="none" aria-hidden="true">
                <defs>
                  <linearGradient id="checkGrad" x1="0" y1="0" x2="96" y2="96" gradientUnits="userSpaceOnUse">
                    <stop offset="0%"   stopColor="#009643" />
                    <stop offset="45%"  stopColor="#06637C" />
                    <stop offset="100%" stopColor="#1100E9" />
                  </linearGradient>
                </defs>
                <circle className="check-circle" cx="48" cy="48" r="44" stroke="url(#checkGrad)" strokeWidth="3.5" strokeLinecap="round" />
                <path className="check-path" d="M27 48 L41 62 L69 36" stroke="url(#checkGrad)" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>

            <div className="content-reveal">
              <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-3 gradient-text">License Purchased</h1>
              <p className="text-gray-500 text-lg leading-relaxed mb-8">
                Your Yopass Business License is on its way. You'll receive the license key by email within a few minutes.
              </p>

              <div className="rounded-2xl border border-blue-100 bg-blue-50/60 px-5 py-4 mb-8 text-left flex gap-3.5 items-start">
                <div className="shrink-0 mt-0.5 w-8 h-8 rounded-full gradient-brand flex items-center justify-center">
                  <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-800 mb-0.5">License sent to your email</p>
                  <p className="text-sm text-gray-500 leading-relaxed">
                    If it doesn't arrive within 10 minutes, check your spam folder or reach out to{' '}
                    <a href="mailto:johan@yopass.se" className="text-brand-blue hover:underline font-medium">johan@yopass.se</a>.
                  </p>
                </div>
              </div>

              <div className="text-left space-y-3 mb-10">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Next steps</p>
                {[
                  <>Check your inbox for the license key email from <span className="font-medium">johan@yopass.se</span></>,
                  <>Follow the <a href="https://github.com/jhaals/yopass#installation" target="_blank" rel="noopener noreferrer" className="text-brand-blue hover:underline font-medium">installation docs</a> to deploy your instance</>,
                  <>Set <code className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">LICENSE_KEY</code> in your deployment environment</>,
                ].map((step, i) => (
                  <div key={i} className="flex gap-3 items-start">
                    <span className="shrink-0 w-5 h-5 rounded-full gradient-brand text-white text-xs font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                    <p className="text-sm text-gray-600">{step}</p>
                  </div>
                ))}
              </div>

              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <a
                  href="https://github.com/jhaals/yopass#installation"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="gradient-brand text-white px-7 py-3.5 rounded-full text-sm font-semibold hover:opacity-90 transition-opacity shadow-lg shadow-brand-blue/20"
                >
                  View Documentation
                </a>
                <a href="/" className="border-2 border-gray-200 text-gray-700 px-7 py-3.5 rounded-full text-sm font-semibold hover:border-gray-400 transition-colors">
                  Back to Yopass
                </a>
              </div>
            </div>
          </div>
        </main>

        <footer className="py-8 text-center">
          <p className="text-sm text-gray-400">
            Questions? Email <a href="mailto:johan@yopass.se" className="hover:text-gray-600 transition-colors">johan@yopass.se</a>
          </p>
        </footer>
      </div>
    </Layout>
  );
}
