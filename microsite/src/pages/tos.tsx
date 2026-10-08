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
          <p className="text-gray-500 mb-12">Effective date: October 7, 2026</p>

          <div className="space-y-10">

            <section>
              <h2 className="text-xl font-bold mb-3">1. Parties and Acceptance</h2>
              <p className="text-gray-600 leading-relaxed">These Terms of Service (the "Terms") form a binding agreement between you, the organization purchasing or using a Yopass Business License ("you" or "Customer"), and Yopass AB, a Swedish limited liability company with company registration number 559603-4727 and VAT registration number SE559603472701, at Norrhällby Haga 39, 754 73 Uppsala, Sweden ("Yopass", "we", or "us"). By purchasing, activating, or using a Business License you accept these Terms on behalf of your organization and confirm you are authorized to do so. These Terms apply to the Business License and related support, not to rights granted under an open source license. If you do not agree, do not purchase or activate a Business License.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">2. Business Customers Only</h2>
              <p className="text-gray-600 leading-relaxed">Yopass Business is sold exclusively to businesses (including sole traders) and organizations acting in a commercial or professional capacity. It is not offered to consumers. By purchasing, you represent that you are acting in the course of a trade, business, craft, or profession. Consumer purchases are not accepted. Nothing in these Terms excludes rights that apply under mandatory law.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">3. License Grant</h2>
              <p className="text-gray-600 leading-relaxed">Subject to these Terms and payment of the applicable fees, you are granted a non-exclusive, non-transferable, non-sublicensable license to use Yopass Business Edition for the duration of your subscription period. The license is valid for a single organization and its deployments, unless a different scope is agreed in writing. Employees and contractors may use and administer those deployments on your behalf. You may share secrets with external recipients and request secrets from them in the course of your own business; this does not authorize resale of the software or a competing service. Yopass and the respective rights holders retain their intellectual property rights; no ownership is transferred. Suspension and termination are governed by Section 14.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">4. Permitted Use</h2>
              <p className="text-gray-600 leading-relaxed">The Business License permits you to:</p>
              <ul className="mt-3 space-y-2 text-gray-600 leading-relaxed list-disc list-inside">
                <li>Deploy Yopass with custom branding and theming within your organization</li>
                <li>Use higher upload size limits as specified in your plan</li>
                <li>Use business features such as OpenID Connect authentication, audit logging, secret requests, read receipts, and webhooks as included in your plan</li>
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
              <p className="text-gray-600 leading-relaxed">The Business License is billed annually at €149/year, unless another price is agreed in your order. The price, currency, billing period, and applicable taxes are shown at checkout before payment. Subscriptions renew automatically for another year unless cancelled before the renewal date. Prices exclude VAT; applicable VAT is added at checkout. Reverse-charge treatment applies only where its legal requirements are met. Payments are processed by Stripe on our behalf; Yopass AB is your supplier and contractual counterparty. We do not receive or store your full payment card details. Suspension for non-payment is governed by Section 14.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">7. Refunds and Cancellation</h2>
              <p className="text-gray-600 leading-relaxed">Fees are non-refundable for cancellation during a paid subscription period, except as stated in these Terms, separately agreed in writing, or required by mandatory law.</p>
              <p className="text-gray-600 leading-relaxed mt-3">Other refund requests are considered on a case-by-case basis at the discretion of Yopass. This does not affect refunds owed under Section 14 or mandatory law. Granting a refund in one instance creates no obligation or precedent for any other. Send refund requests to <a href="mailto:johan@yopass.se" className="underline hover:text-gray-900 transition-colors">johan@yopass.se</a> with the order details and reason.</p>
              <p className="text-gray-600 leading-relaxed mt-3">You may cancel at any time before renewal by emailing johan@yopass.se with your company name and subscription details. A cancellation request received before the renewal date prevents the next renewal, even if we process it later. Cancellation stops future billing; it does not refund fees already paid, and the license remains valid until the end of the paid period, unless terminated under Section 14.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">8. Self-Hosted Software — Your Responsibility</h2>
              <p className="text-gray-600 leading-relaxed">Yopass Business is software you deploy and operate on your own infrastructure. Unless separately agreed in writing, we do not host it, do not operate it, and have no access to your servers, your storage backend, your users, or any secrets, files, or data handled by your deployment. You are solely responsible for:</p>
              <ul className="mt-3 space-y-2 text-gray-600 leading-relaxed list-disc list-inside">
                <li>Installing, configuring, securing, updating, monitoring, and backing up your deployment</li>
                <li>The security of the systems, networks, TLS configuration, and storage backends you run it on</li>
                <li>Determining whether the software is suitable and sufficient for your security, compliance, and regulatory requirements</li>
                <li>All content transmitted through, and all use made of, your deployment — including by your employees, contractors, and end users</li>
                <li>Compliance with applicable data protection law in respect of any personal data your deployment processes</li>
              </ul>
              <p className="text-gray-600 leading-relaxed mt-3">We do not process data in your self-hosted deployment on your behalf merely by providing the software. Our processing of business contact, billing, and support data is described in our Privacy Policy. Do not send us production secrets, credentials, or unnecessary personal data in support requests. Any separate arrangement that gives us access to personal data on your behalf must be documented, including a data processing agreement where required.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">9. Support</h2>
              <p className="text-gray-600 leading-relaxed">Support is provided on a commercially reasonable-efforts basis by email during Swedish business days. No service level agreement, guaranteed response time, uptime commitment, or guaranteed resolution applies unless separately agreed in a signed written agreement. Support does not include custom development, integration work, or administration of your infrastructure.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">10. Third-Party and Open Source Components</h2>
              <p className="text-gray-600 leading-relaxed">The software incorporates third-party and open source components licensed by their respective owners, and may interoperate with third-party services you choose to use. Open source components, including code covered by the Apache License 2.0, remain subject to their respective licenses. These Terms do not restrict the rights those licenses grant, including rights to use, modify, and redistribute that code. Third-party services you select are subject to their providers' terms. This does not remove our obligations under these Terms for the Business License and support we supply.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">11. Disclaimer of Warranties</h2>
              <p className="text-gray-600 leading-relaxed">Except for commitments expressly stated in these Terms or a separate written agreement, and to the extent permitted by law, the software is provided "as is" without additional warranties, including implied warranties of fitness for a particular purpose or non-infringement.</p>
              <p className="text-gray-600 leading-relaxed mt-3">We do not guarantee uninterrupted or error-free operation, protection against every security threat, or suitability for your particular compliance requirements. Encryption, expiry, and deletion depend on your configuration and infrastructure; recipients can retain copies of content they have accessed. You must assess suitability, keep your deployment updated, and maintain appropriate security measures. This section does not override an express commitment we make in your order or exclude liability described in Section 12.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">12. Limitation of Liability</h2>
              <p className="text-gray-600 leading-relaxed">To the fullest extent permitted by law, Yopass shall not be liable for any indirect, incidental, special, punitive, exemplary, or consequential damages, nor for any loss of profits, revenue, goodwill, business, anticipated savings, or opportunity; loss, corruption, or unauthorized access to or disclosure of data, secrets, credentials, or files; business interruption; regulatory fines or penalties; or the cost of substitute products or services — in each case however caused, whether in contract, tort (including negligence), strict liability, or otherwise, and even if Yopass has been advised of the possibility of such damages.</p>
              <p className="text-gray-600 leading-relaxed mt-3">Yopass AB's total aggregate liability arising out of or relating to these Terms or the software, from all claims combined, shall not exceed the amount actually paid by you for the license in the twelve (12) months immediately preceding the event giving rise to the claim. Where no fees have been paid, Yopass AB's total aggregate liability shall not exceed €100.</p>
              <p className="text-gray-600 leading-relaxed mt-3">The liability cap does not reduce an express refund obligation under Section 14. These limitations apply even if a limited remedy is found to have failed of its essential purpose, and reflect an agreed allocation of risk that forms an essential basis of the bargain and of the price charged. Nothing in these Terms excludes or limits liability that cannot lawfully be excluded or limited, including liability for gross negligence, willful misconduct, or death or personal injury caused by negligence.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">13. Indemnification</h2>
              <p className="text-gray-600 leading-relaxed">You will reimburse Yopass AB for damages and reasonable legal costs arising from third-party claims to the extent caused by your unlawful content, unlawful use of the software, or material breach of these Terms. This does not cover claims caused by our breach, negligence, or willful misconduct. We must notify you promptly, allow you to participate in the defence, and take reasonable steps to limit the loss. Neither party may settle a claim in a way that imposes an obligation or admission on the other without that party's written consent.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">14. Term and Termination</h2>
              <p className="text-gray-600 leading-relaxed">These Terms apply for the paid subscription period. You may cancel renewal under Section 7. Either party may terminate for a material breach that remains unremedied fourteen (14) days after written notice describing the breach. We may suspend business entitlements immediately where reasonably necessary to prevent unlawful use or a serious security risk, and will explain the reason and restore them when the issue is resolved. Non-payment is subject to the same notice and cure period. If we discontinue your paid license for reasons other than your breach, or you terminate for our unremedied material breach, we will refund the fees for the unused part of the paid period. On expiry or termination, your entitlement to business features ends; you must stop using those features and remove or replace the license key as appropriate. Rights under applicable open source licenses continue. Features may become unavailable on license expiry, as described in the documentation; plan for this in your deployment. Sections 8 and 10 through 13, 17, and 19 survive to the extent needed to give them effect.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">15. Changes to Terms</h2>
              <p className="text-gray-600 leading-relaxed">We may update these Terms or the subscription price for future subscription periods. We will email you notice of material changes at least thirty (30) days before the renewal at which they take effect, so you can cancel before renewal. If notice is given less than thirty days before an upcoming renewal, the changes apply only at the following renewal, unless you expressly agree otherwise. Changes do not reduce your rights or increase the price during an already paid period without your agreement.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">16. Customer Recognition</h2>
              <p className="text-gray-600 leading-relaxed">We may use your company name or logo as a customer reference only with your prior permission. You may withdraw that permission by emailing <a href="mailto:johan@yopass.se" className="underline hover:text-gray-900 transition-colors">johan@yopass.se</a>; we will then remove the reference from materials under our control within a reasonable time.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">17. Governing Law and Disputes</h2>
              <p className="text-gray-600 leading-relaxed">These Terms are governed by the laws of Sweden, without regard to its conflict of law rules. The United Nations Convention on Contracts for the International Sale of Goods does not apply. Any dispute arising out of or in connection with these Terms shall be settled exclusively by the courts of Sweden, with Stockholm District Court as the court of first instance.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">18. Force Majeure</h2>
              <p className="text-gray-600 leading-relaxed">Yopass is not liable for any delay or failure to perform caused by circumstances beyond its reasonable control, including acts of nature, war, terrorism, civil unrest, labor disputes, epidemics, government action, sanctions, failures of internet or telecommunications infrastructure, hosting or payment provider outages, cyberattacks, or illness or incapacity of key personnel.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">19. General</h2>
              <p className="text-gray-600 leading-relaxed">These Terms and your agreed order constitute the entire agreement between the parties regarding the Business License and supersede all prior discussions, proposals, and representations. An order or separate agreement expressly accepted by both parties takes precedence over these Terms in the event of a conflict. Our <a href="/privacy" className="underline hover:text-gray-900 transition-colors">Privacy Policy</a> explains our processing of personal data and is not consent to that processing. Any conflicting or additional terms in your purchase order or vendor documents are rejected and have no effect unless accepted by Yopass in a signed writing. If any provision is held unenforceable, it will be modified to the minimum extent necessary or severed, and the remaining provisions remain in full force. No failure or delay in enforcing a provision waives it. You may not assign these Terms without our prior written consent; we may assign them in connection with a merger, acquisition, or sale of the relevant business, provided this does not reduce your contractual rights and we notify you of the new counterparty. Publication of these Terms does not by itself transfer an existing contract with Johan Haals to Yopass AB; any such transfer must be handled separately under the existing agreement and applicable law. The parties are independent contractors, and nothing here creates a partnership, agency, or employment relationship.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-3">20. Contact</h2>
              <p className="text-gray-600 leading-relaxed">Yopass AB · Norrhällby Haga 39, 754 73 Uppsala, Sweden · Company registration number: 559603-4727 · VAT registration number: SE559603472701. For questions about these terms, contact <a href="mailto:johan@yopass.se" className="underline hover:text-gray-900 transition-colors">johan@yopass.se</a>.</p>
            </section>

          </div>
        </main>

        <footer className="py-10 border-t border-gray-100">
          <div className="max-w-4xl mx-auto px-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <p className="text-sm text-gray-400">© {new Date().getFullYear()} Yopass AB</p>
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
