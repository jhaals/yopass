import React from 'react';
import Layout from '@theme/Layout';
import Head from '@docusaurus/Head';

export default function TermsOfService(): React.ReactElement {
  return (
    <Layout title="Terms of Service — Yopass" noFooter>
      <Head>
        <meta name="description" content="Terms of Service for Yopass Business License." />
        <meta name="robots" content="noindex, follow" />
      </Head>

      <div className="bg-surface text-gray-900">
        <main className="max-w-4xl mx-auto px-6 py-16 md:py-24">
          <p className="code-accent text-brand-teal mb-4">Legal</p>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">Terms of Service</h1>
          <p className="text-gray-500 mb-12">Last updated: April 16, 2026</p>

          <div className="space-y-10">

            <section>
              <h2 className="text-xl font-bold mb-3">1. Acceptance of Terms</h2>
              <p className="text-gray-600 leading-relaxed">By purchasing a Yopass Business License, you agree to be bound by these Terms of Service. If you do not agree to these terms, do not complete the purchase or use the software.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">2. License Grant</h2>
              <p className="text-gray-600 leading-relaxed">Upon purchase, you are granted a non-exclusive, non-transferable license to use Yopass Business Edition for the duration of your subscription period. The license is valid for a single organization.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">3. Permitted Use</h2>
              <p className="text-gray-600 leading-relaxed">The Business License permits you to:</p>
              <ul className="mt-3 space-y-2 text-gray-600 leading-relaxed list-disc list-inside">
                <li>Deploy Yopass with custom branding and theming within your organization</li>
                <li>Use higher upload size limits as specified in your plan</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">4. Restrictions</h2>
              <p className="text-gray-600 leading-relaxed">You may not:</p>
              <ul className="mt-3 space-y-2 text-gray-600 leading-relaxed list-disc list-inside">
                <li>Sublicense, sell, or transfer the license to any third party</li>
                <li>Use the software to provide a competing secret-sharing service to external customers</li>
                <li>Remove or alter any proprietary notices or labels on the software</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">5. Subscription and Payment</h2>
              <p className="text-gray-600 leading-relaxed">The Business License is billed annually at €149/year. Subscriptions renew automatically unless cancelled at least 24 hours before the renewal date. Payments are processed by Stripe and subject to their terms of service.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">6. Refunds</h2>
              <p className="text-gray-600 leading-relaxed">Refund requests made within 14 days of purchase will be honored in full. After 14 days, refunds are at the sole discretion of Yopass. Contact <a href="mailto:johan@yopass.se" className="underline hover:text-gray-900 transition-colors">johan@yopass.se</a> for refund requests.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">7. Disclaimer of Warranties</h2>
              <p className="text-gray-600 leading-relaxed">The software is provided "as is" without warranty of any kind, express or implied. Yopass does not warrant that the software will be uninterrupted, error-free, or free of security vulnerabilities.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">8. Limitation of Liability</h2>
              <p className="text-gray-600 leading-relaxed">To the fullest extent permitted by law, Yopass shall not be liable for any indirect, incidental, special, or consequential damages arising out of your use of the software. Total liability shall not exceed the amount paid for the license in the 12 months preceding the claim.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">9. Changes to Terms</h2>
              <p className="text-gray-600 leading-relaxed">We reserve the right to update these terms at any time. Material changes will be communicated via email to the address associated with your license. Continued use after changes constitutes acceptance of the updated terms.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">10. Customer Recognition</h2>
              <p className="text-gray-600 leading-relaxed">By purchasing a Business License, you agree that Yopass may reference your company name or logo on our website and in marketing materials as a customer. If you prefer not to be listed, please contact <a href="mailto:johan@yopass.se" className="underline hover:text-gray-900 transition-colors">johan@yopass.se</a> at any time.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">11. Contact</h2>
              <p className="text-gray-600 leading-relaxed">For questions about these terms, contact <a href="mailto:johan@yopass.se" className="underline hover:text-gray-900 transition-colors">johan@yopass.se</a>.</p>
            </section>

          </div>
        </main>

        <footer className="py-10 border-t border-gray-100">
          <div className="max-w-4xl mx-auto px-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <p className="text-sm text-gray-400">Created by Johan Haals · © {new Date().getFullYear()} Yopass</p>
            <div className="flex items-center gap-6">
              <a href="/" className="text-sm text-gray-500 hover:text-gray-900 transition-colors">Home</a>
              <a href="mailto:johan@yopass.se" className="text-sm text-gray-500 hover:text-gray-900 transition-colors">Contact</a>
            </div>
          </div>
        </footer>
      </div>
    </Layout>
  );
}
