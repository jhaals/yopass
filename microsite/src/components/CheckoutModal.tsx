import React, { useState, useEffect, type FormEvent } from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const COUNTRIES = [
  { code: 'AT', label: 'Austria' },
  { code: 'BE', label: 'Belgium' },
  { code: 'BG', label: 'Bulgaria' },
  { code: 'CH', label: 'Switzerland' },
  { code: 'HR', label: 'Croatia' },
  { code: 'CY', label: 'Cyprus' },
  { code: 'CZ', label: 'Czech Republic' },
  { code: 'DK', label: 'Denmark' },
  { code: 'EE', label: 'Estonia' },
  { code: 'FI', label: 'Finland' },
  { code: 'FR', label: 'France' },
  { code: 'DE', label: 'Germany' },
  { code: 'GR', label: 'Greece' },
  { code: 'HU', label: 'Hungary' },
  { code: 'IE', label: 'Ireland' },
  { code: 'IT', label: 'Italy' },
  { code: 'LV', label: 'Latvia' },
  { code: 'LT', label: 'Lithuania' },
  { code: 'LU', label: 'Luxembourg' },
  { code: 'MT', label: 'Malta' },
  { code: 'NL', label: 'Netherlands' },
  { code: 'PL', label: 'Poland' },
  { code: 'PT', label: 'Portugal' },
  { code: 'RO', label: 'Romania' },
  { code: 'SK', label: 'Slovakia' },
  { code: 'SI', label: 'Slovenia' },
  { code: 'ES', label: 'Spain' },
  { code: 'SE', label: 'Sweden' },
  { code: 'GB', label: 'United Kingdom' },
  { code: 'US', label: 'United States' },
];

export default function CheckoutModal({ isOpen, onClose }: Props): React.ReactElement | null {
  const { siteConfig } = useDocusaurusContext();
  const checkoutUrl = (siteConfig.customFields?.checkoutUrl as string) ?? '';

  const [company, setCompany]     = useState('');
  const [email, setEmail]         = useState('');
  const [country, setCountry]     = useState('');
  const [vat, setVat]             = useState('');
  const [error, setError]         = useState('');
  const [submitLabel, setSubmitLabel] = useState('Continue to Payment →');
  const [submitting, setSubmitting]   = useState(false);

  const showVat  = Boolean(country) && country !== 'US';
  const vatLabel = country === 'GB' ? 'UK VAT Number' : country === 'CH' ? 'Swiss VAT Number (UID)' : 'VAT Number';

  useEffect(() => {
    document.body.style.overflow = isOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    setSubmitLabel('Validating…');

    try {
      const resp = await fetch(checkoutUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_name: company.trim(),
          email: email.trim(),
          country,
          vat_number: vat.trim(),
        }),
      });

      const data = await resp.json();

      if (!resp.ok || data.error) {
        setError(data.error ?? 'Something went wrong. Please try again.');
        setSubmitting(false);
        setSubmitLabel('Continue to Payment →');
        return;
      }

      setSubmitLabel('Redirecting…');
      window.location.href = data.url;
    } catch {
      setError('Could not connect to the checkout service. Please try again.');
      setSubmitting(false);
      setSubmitLabel('Continue to Payment →');
    }
  }

  if (!isOpen) return null;

  const inputClass =
    'w-full rounded-lg border border-gray-200 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/40 focus:border-brand-blue transition-colors';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="checkout-title"
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md p-8 z-10">
        <button
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-700 transition-colors"
          aria-label="Close"
          onClick={onClose}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <h2 id="checkout-title" className="text-xl font-bold mb-1">Get Business License</h2>
        <p className="text-sm text-gray-500 mb-6">€149 / year · Available to companies in the EU, UK, USA, and Switzerland. Subscription handled by Stripe</p>

        <form noValidate className="space-y-4" onSubmit={handleSubmit}>
          <div>
            <label htmlFor="co-company" className="block text-sm font-medium text-gray-700 mb-1">Company Name</label>
            <input
              id="co-company" type="text" required autoComplete="organization"
              value={company} onChange={e => setCompany(e.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="co-email" className="block text-sm font-medium text-gray-700 mb-1">Work Email</label>
            <input
              id="co-email" type="email" required autoComplete="email"
              value={email} onChange={e => setEmail(e.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="co-country" className="block text-sm font-medium text-gray-700 mb-1">Country</label>
            <select
              id="co-country" required
              value={country}
              onChange={e => { setCountry(e.target.value); setVat(''); setError(''); }}
              className={`${inputClass} bg-white`}
            >
              <option value="">Select country…</option>
              {COUNTRIES.map(c => (
                <option key={c.code} value={c.code}>{c.label}</option>
              ))}
            </select>
          </div>

          {showVat && (
            <div>
              <label htmlFor="co-vat" className="block text-sm font-medium text-gray-700 mb-1">{vatLabel}</label>
              <input
                id="co-vat" type="text" autoComplete="off" placeholder={country === 'CH' ? 'e.g. CHE-106.067.948' : 'e.g. DE811257892'}
                value={vat} onChange={e => setVat(e.target.value)}
                className={`${inputClass} font-mono`}
              />
              <p className="text-xs text-gray-400 mt-1.5">Required for EU, UK, and Swiss companies. Used for B2B reverse-charge VAT.</p>
            </div>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-3.5 rounded-full gradient-brand text-white text-sm font-semibold hover:opacity-90 transition-opacity shadow-lg shadow-brand-blue/20 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitLabel}
          </button>
        </form>
      </div>
    </div>
  );
}
