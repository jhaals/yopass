import React from 'react';
import Layout from '@theme/Layout';
import Head from '@docusaurus/Head';

const ANIMATIONS = `
  .cancel-card { animation: cardIn 0.5s cubic-bezier(0.16, 1, 0.3, 1) both; }
  @keyframes cardIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }

  .cancel-circle {
    stroke-dasharray: 276; stroke-dashoffset: 276;
    animation: drawCircle 0.55s cubic-bezier(0.65, 0, 0.45, 1) 0.2s forwards;
  }
  @keyframes drawCircle { to { stroke-dashoffset: 0; } }

  .cancel-arrow {
    stroke-dasharray: 60; stroke-dashoffset: 60;
    animation: drawArrow 0.35s cubic-bezier(0.65, 0, 0.45, 1) 0.65s forwards;
  }
  @keyframes drawArrow { to { stroke-dashoffset: 0; } }

  .content-reveal { animation: fadeUpSmall 0.5s ease 0.4s both; }
  @keyframes fadeUpSmall { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
`;

export default function CheckoutCanceled(): React.ReactElement {
  return (
    <Layout title="Purchase Canceled — Yopass" noFooter>
      <Head>
        <meta name="description" content="Your purchase was canceled. No charges were made." />
        <meta name="robots" content="noindex" />
        <style>{ANIMATIONS}</style>
      </Head>

      <div className="mesh-bg min-h-screen bg-[#fafbfc] flex flex-col">
        <main className="flex-1 flex items-center justify-center px-6 py-16">
          <div className="cancel-card glass-card rounded-3xl p-10 md:p-14 max-w-lg w-full text-center">

            <div className="mb-8 flex justify-center">
              <svg width="88" height="88" viewBox="0 0 96 96" fill="none" aria-hidden="true">
                <defs>
                  <linearGradient id="cancelGrad" x1="0" y1="0" x2="96" y2="96" gradientUnits="userSpaceOnUse">
                    <stop offset="0%"   stopColor="#9ca3af" />
                    <stop offset="100%" stopColor="#6b7280" />
                  </linearGradient>
                </defs>
                <circle className="cancel-circle" cx="48" cy="48" r="44" stroke="url(#cancelGrad)" strokeWidth="3.5" strokeLinecap="round" />
                <path className="cancel-arrow" d="M55 35 L36 48 L55 61" stroke="url(#cancelGrad)" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>

            <div className="content-reveal">
              <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-3 text-gray-800">Purchase Canceled</h1>
              <p className="text-gray-500 text-lg leading-relaxed mb-8">
                No worries — no charge was made. You can complete your purchase anytime.
              </p>

              <div className="rounded-2xl border border-gray-200 bg-gray-50/80 px-5 py-4 mb-10 text-left flex gap-3.5 items-start">
                <div className="shrink-0 mt-0.5">
                  <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-700 mb-0.5">Your card was not charged</p>
                  <p className="text-sm text-gray-500 leading-relaxed">
                    The checkout session was canceled before payment was captured. No charges were made.
                  </p>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <a
                  href="/#pricing"
                  className="gradient-brand text-white px-7 py-3.5 rounded-full text-sm font-semibold hover:opacity-90 transition-opacity shadow-lg shadow-brand-blue/20"
                >
                  Back to Pricing
                </a>
                <a
                  href="mailto:johan@yopass.se"
                  className="border-2 border-gray-200 text-gray-700 px-7 py-3.5 rounded-full text-sm font-semibold hover:border-gray-400 transition-colors"
                >
                  Contact Support
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
