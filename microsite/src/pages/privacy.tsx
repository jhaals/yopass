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
              <p className="text-sm text-gray-500 mb-10">Effective date: October 7, 2026</p>

              <div className="space-y-8 text-gray-700">

                <section>
                  <h2 className="text-lg font-semibold text-gray-900 mb-2">1. Who we are and scope</h2>
                  <p>Yopass AB, Norrhällby Haga 39, 754 73 Uppsala, Sweden, company registration number 559603-4727 and VAT registration number SE559603472701, is the controller of personal data used to operate yopass.se, administer Business Licenses, handle billing, and provide support. Contact <a href="mailto:johan@yopass.se" className="text-brand-teal hover:underline">johan@yopass.se</a> with privacy questions or requests.</p><p className="mt-3">This policy does not cover personal data processed by customers in their self-hosted deployments. Each customer is responsible for that processing and its own privacy information. The public demo at share.yopass.se is a separate service; consult its privacy notice before using it.</p>
                </section>

                <section>
                  <h2 className="text-lg font-semibold text-gray-900 mb-2">2. Information we process</h2>
                  <p><strong>Business and billing information:</strong> company name, contact name and email, country, billing address, tax identification number, purchase and subscription records, and payment status. Information entered into our purchase form is sent to our licensing service before you proceed to Stripe Checkout. Stripe collects payment details; we do not receive or store your full payment card details.</p><p className="mt-3"><strong>License information:</strong> company name, contact email, subscription status, acceptance of terms, and license records. License keys include a company identifier and expiry date. Verification in your self-hosted deployment takes place locally.</p><p className="mt-3"><strong>Support correspondence:</strong> information you send when requesting help. Do not include secrets, credentials, or unnecessary personal data.</p><p className="mt-3"><strong>Technical information:</strong> IP address and request information processed by our hosting and licensing infrastructure to deliver requests, diagnose errors, and prevent abuse.</p>
                </section>

                <section>
                  <h2 className="text-lg font-semibold text-gray-900 mb-2">3. Purposes and legal bases</h2>
                  <p>For license and support administration, we rely on our legitimate interest in supplying and supporting software for business customers and communicating with their representatives. Where you are personally a party to the contract, such as a sole trader, processing necessary to supply the license or take steps at your request is based on that contract.</p><p className="mt-3">Accounting and tax processing is based on our legal obligations. Security and abuse prevention rely on our legitimate interest in protecting our services and customers. Processing to establish, exercise, or defend legal claims relies on our legitimate interest in protecting our legal rights.</p><p className="mt-3">Contact and billing information requested for an order is needed to administer the purchase; without it we may be unable to supply a license. We do not use your data for decisions that produce legal or similarly significant effects based solely on automated processing.</p>
                </section>

                <section>
                  <h2 className="text-lg font-semibold text-gray-900 mb-2">4. Recipients and international transfers</h2>
                  <p>Customer and subscription records are held in Stripe, with the records needed for accounting also kept in our bookkeeping records. Authorized people administering Yopass AB may access those records to manage licenses, billing, and support. Our licensing service receives the information submitted through the purchase form. Cloudflare hosts this website and processes technical request information to deliver and secure it. Support correspondence is processed when you contact us. Data may also be disclosed to accounting service providers, professional advisers, or authorities where needed for bookkeeping, legal obligations, or legal claims.</p><p className="mt-3">Stripe acts as our processor for some activities and as an independent controller for others, including its own fraud prevention and legal compliance. See <a href="https://stripe.com/privacy" className="text-brand-teal hover:underline" target="_blank" rel="noopener noreferrer">Stripe's Privacy Policy</a> and <a href="https://www.cloudflare.com/privacypolicy/" className="text-brand-teal hover:underline" target="_blank" rel="noopener noreferrer">Cloudflare's Privacy Policy</a> for their processing.</p><p className="mt-3">Providers may process personal data outside the European Economic Area. Such transfers require an applicable safeguard, such as an adequacy decision or the European Commission's standard contractual clauses and any necessary supplementary measures. Contact us for information about the safeguards applicable to your data or a copy of them.</p>
                </section>

                <section>
                  <h2 className="text-lg font-semibold text-gray-900 mb-2">5. Retention</h2>
                  <p>We retain accounting records until the end of the seventh year after the calendar year in which the financial year ended, as required by Swedish accounting law. This does not require us to retain all support data for that period.</p><p className="mt-3">Other license and contact records are retained while needed to administer the customer relationship and any outstanding obligations or legal claims. Support correspondence is retained as needed to resolve the request and related claims. Technical logs are retained only as needed for security and troubleshooting. We delete or anonymize information when the relevant purpose no longer requires it. Providers acting as independent controllers set their own retention periods.</p>
                </section>

                <section>
                  <h2 className="text-lg font-semibold text-gray-900 mb-2">6. Cookies and analytics</h2>
                  <p>We do not load Google Analytics or set analytics or advertising cookies on this website. Our infrastructure and Stripe's checkout may use technologies necessary to deliver or secure the service you request. Stripe provides its own information about technologies used on its hosted checkout. Any future use of non-essential cookies will require your prior consent, with a way to withdraw it.</p>
                </section>

                <section>
                  <h2 className="text-lg font-semibold text-gray-900 mb-2">7. Your rights</h2>
                  <p>Under applicable data protection law, you may request access, correction, erasure, restriction, and, where applicable, portability of your personal data. You may object to processing based on legitimate interests. These rights are subject to legal conditions; for example, accounting obligations may prevent immediate deletion of invoice records. If processing is based on consent, you may withdraw it at any time without affecting earlier lawful processing.</p><p className="mt-3">Contact <a href="mailto:johan@yopass.se" className="text-brand-teal hover:underline">johan@yopass.se</a> to exercise your rights. You may complain to <a href="https://www.imy.se/" className="text-brand-teal hover:underline" target="_blank" rel="noopener noreferrer">Integritetsskyddsmyndigheten (IMY)</a>, Sweden's supervisory authority, or another competent supervisory authority.</p>
                </section>

                <section>
                  <h2 className="text-lg font-semibold text-gray-900 mb-2">8. Changes and the company transition</h2>
                  <p>We will update this notice when our processing changes and provide additional notice where required. A privacy notice explains processing; continued use of the website is not consent. Publishing this policy does not itself transfer existing customer contracts or records from Johan Haals to Yopass AB. A transfer of existing customer data requires an appropriate legal basis and information to the affected individuals. Records retained by the former business to meet its own legal obligations remain that business's responsibility.</p>
                </section>

              </div>
            </div>
          </div>
        </main>
      </div>
    </Layout>
  );
}
