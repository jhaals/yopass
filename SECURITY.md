# Security Policy

We take the security of urlx seriously. If you believe you have discovered a security vulnerability in urlx, please report it responsibly.

urlx is based on [Yopass](https://github.com/jhaals/yopass). Vulnerabilities that also affect upstream Yopass should additionally be reported to the Yopass maintainer as described in the [Yopass security policy](https://github.com/jhaals/yopass/blob/master/SECURITY.md).

## Security Architecture Overview

urlx is designed with security as the primary focus:

### Core Security Principles

- **Zero-Knowledge Architecture**: Secrets are encrypted client-side before transmission
- **End-to-End Encryption**: Uses OpenPGP encryption with strong cryptographic standards
- **One-Time Access**: Configurable one-time secret viewing to prevent replay attacks
- **Minimal Data Retention**: Secrets automatically expire and are permanently deleted
- **No Plain Text Storage**: The official clients encrypt before anything leaves the browser, so the server stores and serves only ciphertext

This last property is guaranteed by the client, not enforced by the server. The
server checks that a submitted message is a well-formed armored `PGP MESSAGE`
and rejects anything else, but armor alone cannot prove that a payload is
genuinely encrypted, and no server-side check could: a caller can always
encrypt with a key they control. Treat the API as accepting arbitrary
caller-supplied ciphertext, and do not build downstream controls on the
assumption that content which passed urlx's validation is opaque.

### Security Features

- **Client-Side Encryption**: All encryption/decryption happens in the browser
- **Cryptographically Secure Random Generation**: Uses `window.crypto.getRandomValues()`
- **Configurable Expiration**: Time-based secret expiration (1 hour to 1 week by default; optional custom durations within administrator-configured bounds)
- **Access Controls**: One-time viewing enforcement
- **Secure Headers**: Proper Content Security Policy and security headers
- **Input Validation**: Comprehensive input validation and sanitization
- **Memory Safety**: Streaming uploads for large files to prevent memory exhaustion

## Security Vulnerability Disclosure

### Reporting Security Issues

Please follow these guidelines when reporting a security issue:

1. **Report privately through [GitHub security advisories](https://github.com/mehrabiyan/urlx/security/advisories/new)** - Please do not create a public GitHub issue
2. **Include detailed information**:
   - Description of the vulnerability
   - Steps to reproduce the issue
   - Potential impact assessment
   - Affected versions (if known)
   - Suggested mitigations or remediations
   - Your contact information for follow-up

3. **Allow reasonable response time** - We will do our best to respond promptly

### Response Process

When you report a security vulnerability:

1. **Acknowledgment**: We will acknowledge receipt
2. **Investigation**: We will investigate and validate the reported issue
3. **Resolution**: We will develop and test a fix
4. **Disclosure**: We will coordinate disclosure timing with you
5. **Credit**: We will acknowledge your contribution in security advisories (unless you prefer to remain anonymous)

### Security Bounty

While urlx doesn't currently have a formal bug bounty program, we appreciate security research efforts and will acknowledge your contribution in the project

## What Qualifies as a Security Issue

### Valid Security Issues

- **Authentication/Authorization bypasses**
- **Server-side code execution vulnerabilities**
- **Client-side code injection (XSS, CSRF)**
- **Cryptographic implementation flaws**
- **Data exposure vulnerabilities**
- **Privilege escalation issues**
- **Denial of service attacks**
- **Information disclosure beyond intended design**

### Security Issues NOT in Scope

We do not consider the following to be security issues:

- **UUID/Key Enumeration**: Brute-force attacks against UUIDs or encryption keys
- **Browser History/Cache**: URLs being stored in browser history or cache (by design)
- **Build Dependencies**: Vulnerabilities in build-time dependencies not exploitable at runtime
- **Social Engineering**: Issues requiring social engineering or physical access
- **Rate Limiting**: Absence of rate limiting
- **Information Disclosure**: Version information or technology stack disclosure
- **Client-Side Storage**: Temporary storage of encrypted data in browser storage

## Security Best Practices for Users

### For End Users

- **Use Strong Passwords**: When creating custom passwords, use strong, unique passwords
- **Verify Recipients**: Ensure you're sharing secrets with intended recipients only
- **Use One-Time Secrets**: Enable one-time viewing for sensitive information
- **Short Expiration**: Use the shortest practical expiration time
- **Secure Channels**: Share secret URLs through secure communication channels
- **Clear Browser Data**: Clear browser history/cache after accessing secrets

### For Administrators

- **HTTPS Only**: Always deploy urlx with HTTPS/TLS encryption
- **Security Headers**: Configure proper security headers (CSP, HSTS, etc.)
- **Regular Updates**: Keep urlx and dependencies updated
- **Monitor Logs**: Implement proper logging and monitoring
- **Access Controls**: Restrict administrative access appropriately
- **Backup Security**: Ensure backup systems don't contain secrets
- **Network Security**: Deploy behind appropriate network security controls

### Security Advisories

Security updates are published through release notes.

## Contact Information

**Security Contact**: [GitHub security advisories](https://github.com/mehrabiyan/urlx/security/advisories/new)

For urgent security issues, please include "SECURITY" in the advisory title.

---

We appreciate your efforts in keeping urlx secure for everyone. Your responsible disclosure helps maintain the security and privacy that users depend on.