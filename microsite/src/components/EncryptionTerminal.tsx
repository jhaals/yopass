import React, { useEffect, useRef } from 'react';

interface Secret {
  plain: string;
  cipher: string;
  hash: string;
}

const SECRETS: Secret[] = [
  { plain: 'STRIPE_KEY=sk_example_abc123xyz',          cipher: 'hQEMA7x9Kp2mNvQ+AQf/WlXzR3mK8pT', hash: 'yopass.se/s/a3f8b2c1d4e5' },
  { plain: 'DB_PASSWORD=example-password-here',        cipher: 'jA8BxQP3rN7vK2mL9wT+FsYcUeHd1oRZ', hash: 'yopass.se/s/f7d2e9a1b4c8' },
  { plain: 'API_TOKEN=example_token_xyz789',           cipher: 'cQoMA3R7xP2nKv9+BQg/TmWzL4kN6sJy', hash: 'yopass.se/s/b1c6d3e8f2a9' },
  { plain: 'AWS_SECRET=example/aws/secret/key/here',   cipher: 'nBEMA9q3Xt7mKp2+CRh/VwYzN5jL8uFs', hash: 'yopass.se/s/e4f1a7b3c9d2' },
];

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=!@#$%^&*';

export default function EncryptionTerminal(): React.ReactElement {
  const plaintextRef  = useRef<HTMLParagraphElement>(null);
  const ciphertextRef = useRef<HTMLParagraphElement>(null);
  const hashRef       = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const plaintextEl  = plaintextRef.current;
    const ciphertextEl = ciphertextRef.current;
    const hashEl       = hashRef.current;
    if (!plaintextEl || !ciphertextEl || !hashEl) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let idx = 0;
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    const intervals: ReturnType<typeof setInterval>[] = [];

    const randGlyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)];

    function scrambleTo(el: HTMLElement, target: string, duration: number, onDone?: () => void) {
      if (reducedMotion) { el.textContent = target; onDone?.(); return; }
      const steps = Math.ceil(duration / 30);
      let step = 0;
      const iv = setInterval(() => {
        const revealed = Math.floor((step / steps) * target.length);
        let out = target.slice(0, revealed);
        for (let i = revealed; i < target.length; i++) out += randGlyph();
        el.textContent = out;
        if (++step > steps) {
          clearInterval(iv);
          el.textContent = target;
          onDone?.();
        }
      }, 30);
      intervals.push(iv);
    }

    function scrambleAway(el: HTMLElement, duration: number, onDone?: () => void) {
      if (reducedMotion) { el.textContent = ''; onDone?.(); return; }
      const len = el.textContent?.length ?? 0;
      const steps = Math.ceil(duration / 30);
      let step = 0;
      const iv = setInterval(() => {
        const kept = Math.max(0, len - Math.floor((step / steps) * len));
        el.textContent = Array.from({ length: kept }, randGlyph).join('');
        if (++step > steps) { clearInterval(iv); el.textContent = ''; onDone?.(); }
      }, 30);
      intervals.push(iv);
    }

    const runCycle = () => {
      const s = SECRETS[idx++ % SECRETS.length];
      scrambleTo(plaintextEl, s.plain, 700, () => {
        timeouts.push(setTimeout(() => {
          scrambleTo(ciphertextEl, s.cipher, 900, () => {
            hashEl.textContent = s.hash;
            timeouts.push(setTimeout(() => {
              scrambleAway(plaintextEl, 400, () => {
                scrambleAway(ciphertextEl, 400, () => {
                  hashEl.textContent = '';
                  timeouts.push(setTimeout(runCycle, reducedMotion ? 600 : 800));
                });
              });
            }, reducedMotion ? 100 : 1800));
          });
        }, reducedMotion ? 0 : 400));
      });
    };

    timeouts.push(setTimeout(runCycle, 600));

    return () => {
      timeouts.forEach(clearTimeout);
      intervals.forEach(clearInterval);
    };
  }, []);

  return (
    <div
      className="bg-gray-950 rounded-2xl overflow-hidden select-none animate-float terminal-depth"
      aria-hidden="true"
    >
      {/* Window chrome */}
      <div className="flex items-center gap-1.5 px-4 py-3 border-b border-white/[0.06]">
        <div className="w-2.5 h-2.5 rounded-full bg-red-500/50" />
        <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/50" />
        <div className="w-2.5 h-2.5 rounded-full bg-green-500/50" />
        <span className="ml-3 text-[10px] text-gray-600 font-mono tracking-widest">yopass encrypt</span>
      </div>

      <div className="px-5 py-6 space-y-5">
        {/* Plaintext */}
        <div>
          <p className="text-[10px] font-mono text-gray-600 uppercase tracking-widest mb-2">$ secret</p>
          <p ref={plaintextRef} className="font-mono text-sm text-amber-300/90 break-all min-h-[1.25rem]" />
        </div>

        {/* Encryption indicator */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-gradient-to-r from-[#009643]/30 via-[#06637C]/40 to-[#1100E9]/30" />
          <span className="text-[10px] font-mono text-gray-600 tracking-wider flex items-center gap-1.5">
            <svg className="w-3 h-3 text-[#009643]/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            OpenPGP
          </span>
          <div className="flex-1 h-px bg-gradient-to-r from-[#1100E9]/30 via-[#06637C]/40 to-[#009643]/30" />
        </div>

        {/* Ciphertext */}
        <div>
          <p className="text-[10px] font-mono text-gray-600 uppercase tracking-widest mb-2">$ ciphertext</p>
          <p ref={ciphertextRef} className="font-mono text-sm text-green-400/80 break-all min-h-[1.25rem]" />
        </div>

        {/* One-time link */}
        <div className="border-t border-white/[0.06] pt-4 flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-[#06637C]/60 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          <span ref={hashRef} className="font-mono text-[11px] text-gray-500" />
        </div>
      </div>
    </div>
  );
}
