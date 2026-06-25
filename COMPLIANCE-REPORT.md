# Yopass Compliance Report: ISO/IEC 27001 & SOC 2 Type II

**Status:** Informational assessment
**Date:** 2026-06-25
**Scope:** Yopass open-source secret-sharing application (server + web client)
**Audience:** Operators evaluating Yopass for use inside an ISO 27001 ISMS or a SOC 2 reporting boundary

---

## 1. Executive summary

**Short answer: Yopass *the software* is not, and cannot be, "ISO 27001 certified" or "SOC 2 Type II compliant" on its own — those are certifications/attestations of *organizations and their operated services*, not of a codebase.** What Yopass *can* do — and does well — is provide the technical control surface an operator needs to bring a Yopass deployment into scope of *their* ISO 27001 ISMS or *their* SOC 2 report.

This distinction matters and is frequently misstated by vendors:

| Framework | What it actually certifies | Can a piece of software "have" it? |
|-----------|---------------------------|-------------------------------------|
| **ISO/IEC 27001** | An organization's Information Security Management System (ISMS) | No. An organization is certified by an accredited body after audit. |
| **SOC 2 Type II** | The design *and operating effectiveness over a period* (typically 3–12 months) of a service organization's controls | No. A service organization is attested by a licensed CPA firm. |

So the honest framing is:

> Yopass provides a strong set of **technical controls** that map cleanly to many ISO 27001 Annex A controls and to the SOC 2 Trust Services Criteria (TSC). An operator who self-hosts Yopass and surrounds it with the appropriate **organizational** controls (policies, access management, vendor management, monitoring, IR) can include Yopass in a certified ISMS or a SOC 2 report. Yopass alone does not grant either.

**Bottom line for the two questions asked:**

- **"Does Yopass comply with ISO 27001?"** — Not as a standalone claim. Yopass supplies controls supporting roughly the cryptography, access-control, logging, and secure-development families of Annex A. The remaining ~60% of Annex A (people, physical, supplier, continuity, governance) is the operator's responsibility.
- **"Does Yopass comply with SOC 2 Type II?"** — Not as a standalone claim. Yopass strongly supports the **Security (Common Criteria)** and **Confidentiality** categories at the technical layer. Type II specifically requires *evidence of operating effectiveness over time*, which only the operating organization can produce.

The README and docs already use careful language ("Compliance audit logging (SOC 2, ISO 27001, GDPR)") — i.e., a *feature that supports* compliance, not a compliance claim. That framing is accurate and should be preserved.

---

## 2. What Yopass is (architecture relevant to compliance)

Yopass is a self-hostable, zero-knowledge secret-sharing service:

- **Client-side end-to-end encryption.** Secrets are encrypted in the browser with OpenPGP before transmission. The server stores only ciphertext; the decryption key travels in the URL fragment and never reaches the server (`pkg/yopass/yopass.go`).
- **Strong cryptographic primitives.** AES-256 cipher, SHA-256 hash, AEAD/GCM mode, compression disabled (`pgpConfig` in `pkg/yopass/yopass.go:31`). IDs and keys come from `crypto/rand` with ~128 bits of entropy (`GenerateID`, `GenerateKey`).
- **Ephemeral storage.** Secrets live in Memcached or Redis with a TTL (1h / 1d / 1w) and are deleted on first view when one-time (`pkg/server/server.go`).
- **No accounts by default.** Optional OIDC authentication with email-domain allow-listing (`pkg/server/oidc.go`).
- **Stateless server.** Configuration via flags/env; usable as a library without global state.

This architecture means **the server is a low-value target by design**: a full database compromise yields only ciphertext and metadata, never plaintext secrets or decryption keys. That is a powerful position for any confidentiality-focused audit.

---

## 3. ISO/IEC 27001:2022 Annex A mapping

Below, each control family is rated by how much Yopass *contributes* to satisfying it. "Operator" = the organization deploying Yopass.

### Legend
- 🟢 **Strong technical support** — Yopass implements the control or most of it.
- 🟡 **Partial / configurable** — Yopass enables it but the operator must configure or supplement.
- 🔴 **Operator responsibility** — outside the software's control entirely.

### A.5 Organizational controls (37 controls)

| Control | Topic | Status | Notes |
|--------|-------|--------|-------|
| A.5.7 | Threat intelligence | 🔴 | Operator. |
| A.5.10 | Acceptable use of information | 🟡 | `SECURITY.md` documents secure-use guidance for users and admins. |
| A.5.14 | Information transfer | 🟢 | Core purpose: encrypted, expiring, one-time secret transfer replaces plaintext sharing over Slack/email. |
| A.5.15 | Access control | 🟡 | OIDC auth + `require-auth` + email-domain allow-list + per-secret `RequireAuth`. Operator owns IdP/policy. |
| A.5.17 | Authentication information | 🟢 | Zero-knowledge: server never holds the secret or its key. Session cookies are AES-256+HMAC sealed (`securecookie`). |
| A.5.23 | Cloud services security | 🔴 | Operator's cloud posture. |
| A.5.28 | Collection of evidence | 🟢 | Audit log (NDJSON) provides tamper-evident-friendly, structured evidence. |
| A.5.30 | ICT readiness for continuity | 🟡 | `/health` & `/ready` probes; stateless server. Backup/DR is operator's. |
| A.5.31–.34 | Legal, IP, records, privacy | 🟡 | No plaintext retention aids GDPR data-minimization; privacy-notice & imprint URLs configurable. Legal obligations are operator's. |

### A.6 People controls (8 controls) — 🔴 entirely operator
Screening, terms of employment, awareness/training, disciplinary process, remote working, NDAs. Yopass has no bearing on these.

### A.7 Physical controls (14 controls) — 🔴 entirely operator
Data-center, equipment, cabling, secure disposal. Operator's hosting environment.

### A.8 Technological controls (34 controls) — Yopass's strongest area

| Control | Topic | Status | Notes |
|--------|-------|--------|-------|
| A.8.1 | User endpoint devices | 🟡 | Encryption happens on the user's endpoint; endpoint hardening is operator's. |
| A.8.2 | Privileged access rights | 🟡 | OIDC + email-domain restriction; no built-in RBAC beyond auth gate. |
| A.8.3 | Information access restriction | 🟢 | One-time access, per-secret auth requirement, management-token-gated secret requests (constant-time compare, `pkg/server/request.go`). |
| A.8.5 | Secure authentication | 🟢 | OIDC with PKCE (`rp.WithPKCE`), HttpOnly/Secure/SameSite cookies, HKDF-derived multi-instance keys (`pkg/server/oidc.go`). |
| A.8.6 | Capacity management | 🟡 | Prometheus metrics, streaming uploads to bound memory; sizing is operator's. |
| A.8.8 | Management of technical vulnerabilities | 🟢 | Dependabot-driven dependency updates (see git history), `SECURITY.md` disclosure process, Go Report Card / CodeClimate. |
| A.8.9 | Configuration management | 🟡 | All config via documented flags/env; operator owns IaC. |
| A.8.10 | Information deletion | 🟢 | TTL expiry + one-time deletion; secrets purged automatically. No plaintext ever stored. |
| A.8.11 | Data masking | 🟢 | Audit logs hash secret IDs (SHA-256, 12-char fingerprint, `redactSecretID`); secret content never logged. |
| A.8.12 | Data leakage prevention | 🟢 | E2E encryption; webhooks/audit carry only fingerprints, never retrieval keys. |
| A.8.15 | Logging | 🟢 | Dedicated NDJSON audit log of all security-relevant events with outcomes (`pkg/server/audit.go`). |
| A.8.16 | Monitoring activities | 🟡 | Prometheus metrics + audit log; alerting/SIEM integration is operator's. |
| A.8.20–.21 | Network security | 🟡 | Built-in TLS, HSTS, trusted-proxy handling; network segmentation is operator's. |
| A.8.23 | Web filtering | 🔴 | Operator. |
| A.8.24 | Use of cryptography | 🟢 | AES-256-GCM, SHA-256, CSPRNG, OpenPGP; HMAC-SHA256 webhook signatures. |
| A.8.25–.28 | Secure development lifecycle | 🟢 | Tests across the codebase (`*_test.go`), CSP/security headers, input validation, secure coding (constant-time token compare, MaxBytesReader limits). |
| A.8.26 | Application security requirements | 🟢 | CSP, X-Frame-Options DENY, nosniff, referrer-policy no-referrer, HSTS (`SecurityHeadersHandler`). |

**ISO 27001 verdict:** Yopass materially supports **A.8 (Technological)** and a meaningful slice of **A.5 (Organizational)**. It has *no* bearing on **A.6 (People)** and **A.7 (Physical)**, and partial bearing on governance/supplier/continuity controls — all of which are the operator's ISMS responsibility. **Yopass can be an in-scope asset in a certified ISMS; it cannot itself be certified.**

---

## 4. SOC 2 Type II Trust Services Criteria mapping

SOC 2 evaluates controls against five categories. **Security (Common Criteria, CC) is mandatory; the others are optional.** For a secret-sharing tool, **Security + Confidentiality** are the natural scope; **Privacy** is relevant if PII is in play.

### Common Criteria (CC) — mandatory

| TSC | Criterion | Yopass support | Evidence |
|-----|-----------|----------------|----------|
| **CC1** | Control environment (governance, integrity, accountability) | 🔴 Operator | Org-level; software-agnostic. |
| **CC2** | Communication & information | 🟡 | `SECURITY.md`, docs, structured logs provide the information substrate. |
| **CC3** | Risk assessment | 🔴 Operator | Operator's risk program. |
| **CC4** | Monitoring of controls | 🟡 | Audit log + Prometheus metrics feed monitoring; the *process* is operator's. |
| **CC5** | Control activities | 🟡 | Technical control activities present; policies are operator's. |
| **CC6.1** | Logical access — encryption & credentials | 🟢 | E2E encryption, zero-knowledge server, sealed sessions, OIDC. |
| **CC6.2/6.3** | Access provisioning/removal | 🟡 | OIDC domain re-validation on every request (immediate de-provisioning effect, `oidcMeHandler`); IdP lifecycle is operator's. |
| **CC6.6** | Boundary protection | 🟢 | TLS, CORS, security headers, trusted-proxy IP validation. |
| **CC6.7** | Transmission & disposal of data | 🟢 | Ciphertext-in-transit by construction; TTL + one-time disposal. |
| **CC6.8** | Malicious/unauthorized software | 🟡 | Signed dependencies via go.sum; supply-chain hygiene via Dependabot. |
| **CC7.1/7.2** | Detection & monitoring of events | 🟢 | Audit events with `success`/`failure`/`denied` outcomes; metrics. |
| **CC7.3/7.4** | Incident response | 🟡 | Audit trail supports IR; the IR *process* is operator's (`SECURITY.md` covers vuln intake). |
| **CC8.1** | Change management | 🟢 (dev) / 🟡 (deploy) | PR-based workflow, tests, CI in repo; deployment change mgmt is operator's. |
| **CC9** | Risk mitigation / vendor management | 🔴 Operator | Operator owns vendor/BCP. |

### Confidentiality (C1) — the standout category

| TSC | Criterion | Yopass support |
|-----|-----------|----------------|
| **C1.1** | Identify & protect confidential information | 🟢 Everything is treated as confidential and encrypted client-side. |
| **C1.2** | Dispose of confidential information | 🟢 Automatic TTL expiry + one-time deletion; no plaintext persistence. |

Yopass is essentially a **purpose-built confidentiality control**. This is where it shines in a SOC 2 context.

### Availability (A1), Processing Integrity (PI1), Privacy (P) — partial
- **Availability:** `/health`, `/ready`, metrics, stateless design help; SLA/DR/capacity are operator's.
- **Processing Integrity:** PGP validation on input, expiration enforcement, atomic one-time claims, constant-time token checks — good integrity primitives; end-to-end processing assurance is operator's.
- **Privacy:** Data-minimization (no plaintext, no accounts, hashed IDs in logs) strongly supports privacy; full GAPP/Privacy criteria require operator policy.

**SOC 2 verdict:** Yopass provides strong **technical** coverage for the **Security** and **Confidentiality** categories. **Type II's defining requirement — demonstrating that controls *operated effectively over a review period* — is inherently organizational** and produced through the operator's evidence collection (access reviews, change tickets, monitoring records, IR runbooks) over 3–12 months. Yopass can be a system component within a SOC 2 report; it cannot hold a SOC 2 report itself.

---

## 5. Gap analysis — what an operator must add

To bring a Yopass deployment into a certified ISMS or a SOC 2 report, the operator must supply the controls Yopass cannot:

**Governance & people (ISO A.5/A.6, SOC CC1–CC5, CC9)**
- ISMS scope, risk assessment, Statement of Applicability
- Security policies, acceptable-use, access-control policy
- Personnel screening, onboarding/offboarding, security awareness training
- Vendor/supplier risk management (hosting, IdP, Memcached/Redis providers)
- Business continuity & disaster recovery plans, tested

**Physical (ISO A.7)**
- Data-center / cloud physical security (typically inherited from IaaS provider's own SOC 2 / ISO 27001 — collect their reports)

**Operational technical controls the operator configures**
- **Always deploy with TLS** (built-in or via reverse proxy — `docs/tls.md`).
- **Enable OIDC** and `--require-auth` with `--oidc-allowed-domains` for authenticated access (`docs/openid-connect.md`).
- **Enable audit logging** (`--audit-log`, license required) and ship NDJSON to a SIEM with retention matching your policy (e.g., 90+ days). Configure log rotation (`docs/audit-logging.md`).
- **Set `--trusted-proxies`** so client IPs in audit logs are accurate and not spoofable.
- **Centralized monitoring/alerting** on the Prometheus metrics (`docs/metrics.md`).
- **Backup & retention policy** for the storage backend (noting secrets are ephemeral by design).
- **Webhook signing secret** if using webhooks, and verify HMAC-SHA256 signatures at the receiver (`docs/webhooks.md`).

**Evidence collection (SOC 2 Type II specific)**
- Periodic access reviews of who can administer the deployment and the IdP
- Change-management records (PRs, approvals, deploy logs)
- Audit-log samples demonstrating monitoring over the review period
- Incident response records / tabletop exercises

---

## 6. Notable strengths Yopass brings to an audit

1. **Zero-knowledge by construction** — the server is not a plaintext custodian, dramatically shrinking the confidentiality attack surface and simplifying data-handling assertions.
2. **Privacy-preserving audit log** — `pkg/server/audit.go` records actor, action, outcome, client IP, and a *hashed* secret ID; encrypted content is never written. This is exactly the shape auditors want: accountable but not over-collecting.
3. **Strong, modern crypto defaults** — AES-256-GCM, SHA-256, CSPRNG, OpenPGP, HMAC-SHA256, HKDF, constant-time token comparison.
4. **Defense-in-depth web controls** — strict CSP, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, conditional HSTS, CORS with explicit origins.
5. **Secure SDLC signals** — broad unit-test coverage, automated dependency updates, a published `SECURITY.md` disclosure policy, and license-gated premium controls (audit log, read receipts, signed webhooks) aimed squarely at compliance buyers.
6. **Data minimization & retention** — automatic TTL expiry and one-time deletion satisfy "dispose of confidential information" criteria almost for free.

## 7. Notable limitations / operator caveats

1. **No built-in RBAC** beyond OIDC presence + email-domain allow-list; no admin/user role separation inside the app.
2. **Audit log integrity** is append-only NDJSON written locally/stdout; tamper-evidence (e.g., immutable storage, log signing, WORM) must be added downstream.
3. **Webhook / `secret.expired` events are best-effort and per-instance** (in-memory watcher; not emitted after restart or across instances) — do not treat them as an authoritative audit source; use the audit log for that.
4. **Rate limiting is explicitly out of scope** (`SECURITY.md`) — operators needing anti-abuse/DoS controls must add them at the proxy/WAF layer.
5. **Premium compliance features require a license** (audit logging, read receipts, signed webhooks). Budget for this if the audit depends on them.
6. **Single-instance request serialization** (`requestMu`) guards only one process; multi-instance deployments rely on the database TTL/delete semantics, not cross-instance CAS.

---

## 8. Conclusion

Yopass is a **well-engineered, security-first application** whose technical controls align strongly with the **cryptography, access-control, logging, and secure-development** portions of ISO 27001 Annex A and with the **Security and Confidentiality** Trust Services Criteria of SOC 2. Its zero-knowledge architecture and privacy-preserving audit log make it an unusually clean fit as an *in-scope asset* within a compliance program.

However, **neither ISO 27001 certification nor a SOC 2 Type II attestation can be held by the Yopass software itself** — both are awarded to *organizations* that operate services under audited management systems and demonstrate control effectiveness over time. Yopass provides perhaps 30–40% of the relevant control surface (the technical part); the operator must supply the remaining governance, people, physical, supplier, continuity, and evidence-collection controls.

**Recommended public phrasing** (consistent with current docs): *"Yopass provides technical controls — end-to-end encryption, zero-knowledge storage, and a privacy-preserving audit log — that help operators meet SOC 2, ISO 27001, and GDPR requirements when deployed within an appropriate information-security program."* Avoid any unqualified claim that "Yopass is ISO 27001 certified" or "SOC 2 compliant," which would be inaccurate and an audit red flag.

---

*This report is an engineering assessment of the Yopass codebase, not a legal opinion or a formal audit. Certification and attestation can only be issued by an accredited certification body (ISO 27001) or a licensed CPA firm (SOC 2).*
