import React from 'react';
import Layout from '@theme/Layout';
import Head from '@docusaurus/Head';

export default function Privacy(): React.ReactElement {
  return (
    <Layout title="Privacy Policy — Yopass" noFooter>
      <Head>
        <meta name="description" content="Privacy policy for Yopass business license purchases." />
        <link rel="canonical" href="https://yopass.se/privacy" />
      </Head>

      <div className="mesh-bg min-h-screen bg-[#fafbfc]">
        <main className="px-6 py-10 pb-24">
          <div className="max-w-2xl mx-auto">
            <div className="glass-card rounded-2xl p-8 md:p-12">

              <h1 className="text-3xl font-bold mb-1">
                <span className="gradient-text">Privacy Policy</span>
              </h1>
              <p className="text-sm text-gray-500 mb-10">Effective date: April 17, 2026</p>

              <div className="space-y-8 text-gray-700">

                <section>
                  <h2 className="text-lg font-semibold text-gray-900 mb-2">1. Who we are</h2>
                  <p>Yopass is operated by Johan Haals. If you have questions about this policy, contact us at <a href="mailto:johan@yopass.se" className="text-brand-teal hover:underline">johan@yopass.se</a>.</p>
                </section>

                <section>
                  <h2 className="text-lg font-semibold text-gray-900 mb-2">2. Information we collect</h2>
                  <p className="mb-3"><strong>Purchase data.</strong> When you buy a Yopass Business License, you provide your name, email address, billing address, and payment details directly to our payment processor, Stripe. We never see or store your payment card details. Stripe retains this data as the data controller for payment processing purposes — see <a href="https://stripe.com/privacy" className="text-brand-teal hover:underline" target="_blank" rel="noopener noreferrer">Stripe's Privacy Policy</a> for details.</p>
                  <p><strong>Analytics data.</strong> This website uses Google Analytics (GA4) to collect standard usage information such as pages visited, time on site, browser and device type, and approximate location derived from your IP address. We do not intentionally send additional personally identifiable information (such as your name or email address) to Google Analytics.</p>
                </section>

                <section>
                  <h2 className="text-lg font-semibold text-gray-900 mb-2">3. How we use your information</h2>
                  <ul className="list-disc list-inside space-y-1">
                    <li>To fulfil your licence purchase and deliver your licence key via email.</li>
                    <li>To send transactional emails related to your purchase (receipts, renewal reminders).</li>
                    <li>To comply with applicable legal and tax obligations.</li>
                    <li>To understand how visitors use our website and improve it (analytics only).</li>
                  </ul>
                </section>

                <section>
                  <h2 className="text-lg font-semibold text-gray-900 mb-2">4. Data processors</h2>
                  <p className="mb-3">We rely on the following third-party processors:</p>
                  <ul className="list-disc list-inside space-y-1">
                    <li><strong>Stripe</strong> — payment processing and billing. Acts as an independent data controller for payment data.</li>
                    <li><strong>Google Analytics</strong> — website analytics.</li>
                  </ul>
                </section>

                <section>
                  <h2 className="text-lg font-semibold text-gray-900 mb-2">5. Data retention</h2>
                  <p>Stripe retains purchase records in accordance with their own retention policy and applicable financial regulations. Google Analytics data is retained for 14 months by default. We do not independently store any personal data beyond what is held by these processors.</p>
                </section>

                <section>
                  <h2 className="text-lg font-semibold text-gray-900 mb-2">6. Cookies</h2>
                  <p>This website sets cookies only through Google Analytics. These cookies are used solely for analytics purposes. You can opt out via the <a href="https://tools.google.com/dlpage/gaoptout" className="text-brand-teal hover:underline" target="_blank" rel="noopener noreferrer">Google Analytics Opt-out Browser Add-on</a> or by disabling cookies in your browser settings.</p>
                </section>

                <section>
                  <h2 className="text-lg font-semibold text-gray-900 mb-2">7. Your rights</h2>
                  <p>If you are located in the European Economic Area or United Kingdom, you have the right to access, correct, delete, or port your personal data, and to object to or restrict its processing. To exercise any of these rights, email <a href="mailto:johan@yopass.se" className="text-brand-teal hover:underline">johan@yopass.se</a>.</p>
                </section>

                <section>
                  <h2 className="text-lg font-semibold text-gray-900 mb-2">8. Changes to this policy</h2>
                  <p>We may update this policy from time to time. When we do, we will revise the effective date at the top of this page. Continued use of the site after changes constitutes acceptance of the updated policy.</p>
                </section>

                <section>
                  <h2 className="text-lg font-semibold text-gray-900 mb-2">9. Contact</h2>
                  <p>Questions or requests regarding this privacy policy: <a href="mailto:johan@yopass.se" className="text-brand-teal hover:underline">johan@yopass.se</a></p>
                </section>

              </div>
            </div>
          </div>
        </main>
      </div>
    </Layout>
  );
}
