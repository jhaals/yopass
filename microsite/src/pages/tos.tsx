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
          <p className="text-gray-500 mb-12">Last updated: July 24, 2026</p>

          <div className="space-y-10">

            <section>
              <h2 className="text-xl font-bold mb-3">1. Parties and Acceptance</h2>
              <p className="text-gray-600 leading-relaxed">These Terms of Service (the "Terms") form a binding agreement between you, the organization purchasing or using a Yopass Business License ("you" or "Customer"), and Johan Haals, sole trader, Sweden, operating as Yopass ("Yopass", "we", or "us"). By purchasing, activating, or using a Business License — including a free trial — you accept these Terms on behalf of your organization and confirm you are authorized to do so. If you do not agree, do not purchase or use the software.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">2. Business Customers Only</h2>
              <p className="text-gray-600 leading-relaxed">Yopass Business is sold exclusively to businesses, organizations, and other legal entities acting in a commercial or professional capacity. It is not offered to consumers. By purchasing, you represent that you are acting in the course of a trade, business, craft, or profession, and you acknowledge that mandatory consumer protection rules — including the statutory right of withdrawal for distance contracts — do not apply to this agreement.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">3. License Grant</h2>
              <p className="text-gray-600 leading-relaxed">Subject to these Terms and payment of the applicable fees, you are granted a non-exclusive, non-transferable, non-sublicensable, revocable license to use Yopass Business Edition for the duration of your subscription period. The license is valid for a single organization. Yopass and its licensors retain all right, title, and interest in and to the software; no ownership is transferred.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">4. Permitted Use</h2>
              <p className="text-gray-600 leading-relaxed">The Business License permits you to:</p>
              <ul className="mt-3 space-y-2 text-gray-600 leading-relaxed list-disc list-inside">
                <li>Deploy Yopass with custom branding and theming within your organization</li>
                <li>Use higher upload size limits as specified in your plan</li>
                <li>Use business features such as secret requests, read receipts, and webhooks as included in your plan</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">5. Restrictions</h2>
              <p className="text-gray-600 leading-relaxed">You may not:</p>
              <ul className="mt-3 space-y-2 text-gray-600 leading-relaxed list-disc list-inside">
                <li>Sublicense, sell, rent, lease, or transfer the license to any third party</li>
                <li>Share, publish, or circumvent license keys or license validation mechanisms</li>
                <li>Use the software to provide a competing secret-sharing service to external customers</li>
                <li>Remove or alter any proprietary notices or labels on the software</li>
                <li>Use the software in violation of any applicable law, export control, or sanctions regulation</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">6. Subscription and Payment</h2>
              <p className="text-gray-600 leading-relaxed">The Business License is billed annually at €149/year. Subscriptions renew automatically unless cancelled at least 24 hours before the renewal date. Prices are exclusive of VAT and any other applicable taxes, which are your responsibility. Payments are processed by Stripe and are subject to their terms of service; we do not receive or store your payment card details. If payment fails or is reversed, we may suspend or terminate the license after reasonable notice.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">7. Refunds and Cancellation</h2>
              <p className="text-gray-600 leading-relaxed">All fees are non-refundable except where required by mandatory law. Because Yopass is sold to businesses, no statutory cooling-off or withdrawal period applies. A free trial is available so you can evaluate the software before purchasing.</p>
              <p className="text-gray-600 leading-relaxed mt-3">Refunds are considered on a case-by-case basis at the sole discretion of Yopass. Granting a refund in one instance creates no obligation or precedent for any other. Send refund requests to <a href="mailto:johan@yopass.se" className="underline hover:text-gray-900 transition-colors">johan@yopass.se</a> with the order details and reason.</p>
              <p className="text-gray-600 leading-relaxed mt-3">You may cancel at any time to prevent the next renewal. Cancellation stops future billing; it does not refund fees already paid, and the license remains valid until the end of the paid period.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">8. Self-Hosted Software — Your Responsibility</h2>
              <p className="text-gray-600 leading-relaxed">Yopass Business is software you deploy and operate on your own infrastructure. We do not host it, do not operate it, and have no access to your servers, your storage backend, your users, or any secrets, files, or data handled by your deployment. You are solely responsible for:</p>
              <ul className="mt-3 space-y-2 text-gray-600 leading-relaxed list-disc list-inside">
                <li>Installing, configuring, securing, updating, monitoring, and backing up your deployment</li>
                <li>The security of the systems, networks, TLS configuration, and storage backends you run it on</li>
                <li>Determining whether the software is suitable and sufficient for your security, compliance, and regulatory requirements</li>
                <li>All content transmitted through, and all use made of, your deployment — including by your employees, contractors, and end users</li>
                <li>Compliance with applicable data protection law in respect of any personal data your deployment processes</li>
              </ul>
              <p className="text-gray-600 leading-relaxed mt-3">We are not a processor of, and accept no responsibility for, data handled by your deployment.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">9. Support</h2>
              <p className="text-gray-600 leading-relaxed">Support is provided on a commercially reasonable-efforts basis by email during Swedish business days. No service level agreement, guaranteed response time, uptime commitment, or guaranteed resolution applies unless separately agreed in a signed written agreement. Support does not include custom development, integration work, or administration of your infrastructure.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">10. Third-Party and Open Source Components</h2>
              <p className="text-gray-600 leading-relaxed">The software incorporates third-party and open source components licensed by their respective owners, and may interoperate with third-party services you choose to use. Those components and services are provided under their own terms, and we make no representation or warranty regarding them and accept no liability for them.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">11. Disclaimer of Warranties</h2>
              <p className="text-gray-600 leading-relaxed">To the maximum extent permitted by law, the software is provided "as is" and "as available", with all faults and without warranty of any kind, whether express, implied, or statutory. Yopass expressly disclaims all implied warranties, including any warranty of merchantability, satisfactory quality, fitness for a particular purpose, title, accuracy, and non-infringement.</p>
              <p className="text-gray-600 leading-relaxed mt-3">Without limiting the foregoing, Yopass does not warrant that the software will be uninterrupted, timely, secure, or error-free; that defects will be corrected; that it is free of vulnerabilities, backdoors, or harmful components; that encryption or deletion will be effective against any particular adversary or in any particular deployment; or that it will meet your requirements or comply with any law or standard applicable to you. No advice or information, whether oral or written, creates any warranty not expressly stated in these Terms. You assume the entire risk arising out of your use of the software.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">12. Limitation of Liability</h2>
              <p className="text-gray-600 leading-relaxed">To the fullest extent permitted by law, Yopass shall not be liable for any indirect, incidental, special, punitive, exemplary, or consequential damages, nor for any loss of profits, revenue, goodwill, business, anticipated savings, or opportunity; loss, corruption, or unauthorized access to or disclosure of data, secrets, credentials, or files; business interruption; regulatory fines or penalties; or the cost of substitute products or services — in each case however caused, whether in contract, tort (including negligence), strict liability, or otherwise, and even if Yopass has been advised of the possibility of such damages.</p>
              <p className="text-gray-600 leading-relaxed mt-3">Yopass total aggregate liability arising out of or relating to these Terms or the software, from all claims combined, shall not exceed the amount actually paid by you for the license in the twelve (12) months immediately preceding the event giving rise to the claim. Where no fees have been paid — including use under a free trial or of the open source edition — Yopass total aggregate liability shall not exceed €100.</p>
              <p className="text-gray-600 leading-relaxed mt-3">These limitations apply even if a limited remedy is found to have failed of its essential purpose, and reflect an agreed allocation of risk that forms an essential basis of the bargain and of the price charged. Nothing in these Terms excludes or limits liability that cannot lawfully be excluded or limited, including liability for gross negligence, willful misconduct, or death or personal injury caused by negligence.</p>
              <p className="text-gray-600 leading-relaxed mt-3">Any claim arising out of or relating to these Terms or the software must be brought within twelve (12) months after the claim arose, or it is permanently barred, unless a longer period is required by mandatory law.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">13. Indemnification</h2>
              <p className="text-gray-600 leading-relaxed">You agree to defend, indemnify, and hold harmless Yopass and Johan Haals from and against any claims, demands, proceedings, damages, losses, liabilities, fines, costs, and expenses (including reasonable legal fees) brought by any third party — including your employees, customers, and end users, and any regulator — arising out of or relating to your deployment or operation of the software, your use of or content transmitted through it, your breach of these Terms, or your violation of any law or third-party right.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">14. Term and Termination</h2>
              <p className="text-gray-600 leading-relaxed">These Terms apply for as long as your license is active. Either party may terminate at the end of the then-current subscription period. Yopass may suspend or terminate your license immediately if you materially breach these Terms — including any breach of Section 5 — or fail to pay. On termination or expiry your right to use the Business Edition ceases and you must stop using business features and remove license keys from your deployments. Sections 8 and 10 through 19 survive termination.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">15. Changes to Terms</h2>
              <p className="text-gray-600 leading-relaxed">We reserve the right to update these terms at any time. Material changes will be communicated via email to the address associated with your license, and take effect on your next renewal or thirty (30) days after notice, whichever is earlier. Continued use after changes constitutes acceptance of the updated terms.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">16. Customer Recognition</h2>
              <p className="text-gray-600 leading-relaxed">By purchasing a Business License, you agree that Yopass may reference your company name or logo on our website and in marketing materials as a customer. If you prefer not to be listed, please contact <a href="mailto:johan@yopass.se" className="underline hover:text-gray-900 transition-colors">johan@yopass.se</a> at any time.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">17. Governing Law and Disputes</h2>
              <p className="text-gray-600 leading-relaxed">These Terms are governed by the laws of Sweden, without regard to its conflict of law rules. The United Nations Convention on Contracts for the International Sale of Goods does not apply. Any dispute arising out of or in connection with these Terms shall be settled exclusively by the courts of Sweden, with Stockholm District Court as the court of first instance. Each party brings claims only in its individual capacity, and not as a plaintiff or class member in any class or representative proceeding.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">18. Force Majeure</h2>
              <p className="text-gray-600 leading-relaxed">Yopass is not liable for any delay or failure to perform caused by circumstances beyond its reasonable control, including acts of nature, war, terrorism, civil unrest, labor disputes, epidemics, government action, sanctions, failures of internet or telecommunications infrastructure, hosting or payment provider outages, cyberattacks, or illness or incapacity of key personnel.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">19. General</h2>
              <p className="text-gray-600 leading-relaxed">These Terms, together with our <a href="/privacy" className="underline hover:text-gray-900 transition-colors">Privacy Policy</a>, constitute the entire agreement between the parties regarding the Business License and supersede all prior discussions, proposals, and representations. Any conflicting or additional terms in your purchase order or vendor documents are rejected and have no effect unless accepted by Yopass in a signed writing. If any provision is held unenforceable, it will be modified to the minimum extent necessary or severed, and the remaining provisions remain in full force. No failure or delay in enforcing a provision waives it. You may not assign these Terms without our prior written consent; we may assign them in connection with a merger, acquisition, or sale of assets. The parties are independent contractors, and nothing here creates a partnership, agency, or employment relationship.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">20. Contact</h2>
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
