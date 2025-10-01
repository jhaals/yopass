# Security Policy

I take the security of Yopass seriously. If you believe you have discovered a security vulnerability in Yopass, I encourage you to report it responsibly.

## Security Architecture Overview

Yopass is designed with security as the primary focus:

### Core Security Principles

- **Zero-Knowledge Architecture**: Secrets are encrypted client-side before transmission
- **End-to-End Encryption**: Uses OpenPGP encryption with strong cryptographic standards
- **One-Time Access**: Configurable one-time secret viewing to prevent replay attacks
- **Minimal Data Retention**: Secrets automatically expire and are permanently deleted
- **No Plain Text Storage**: Server never has access to unencrypted secrets

### Security Features

- **Client-Side Encryption**: All encryption/decryption happens in the browser
- **Cryptographically Secure Random Generation**: Uses `window.crypto.getRandomValues()`
- **Configurable Expiration**: Time-based secret expiration (1 hour to 1 week)
- **Access Controls**: One-time viewing enforcement
- **Secure Headers**: Proper Content Security Policy and security headers
- **Input Validation**: Comprehensive input validation and sanitization
- **Memory Safety**: Streaming uploads for large files to prevent memory exhaustion

## Security Vulnerability Disclosure

### Reporting Security Issues

Please follow these guidelines when reporting a security issue:

1. **Email the report to johan{a}haals.se** - Please do not create a public GitHub issue
2. **Include detailed information**:
   - Description of the vulnerability
   - Steps to reproduce the issue
   - Potential impact assessment
   - Affected versions (if known)
   - Suggested mitigations or remediations
   - Your contact information for follow-up

3. **Allow reasonable response time** - I will do my best to respond promptly

### Response Process

When you report a security vulnerability:

1. **Acknowledgment**: I will acknowledge receipt
2. **Investigation**: I will investigate and validate the reported issue
3. **Resolution**: I will develop and test a fix
4. **Disclosure**: I will coordinate disclosure timing with you
5. **Credit**: I will acknowledge your contribution in security advisories (unless you prefer to remain anonymous)

### Security Bounty

While Yopass doesn't currently have a formal bug bounty program, I deeply appreciate security research efforts and will acknowledge your contribution in the project

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

I do not consider the following to be security issues:

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

- **HTTPS Only**: Always deploy Yopass with HTTPS/TLS encryption
- **Security Headers**: Configure proper security headers (CSP, HSTS, etc.)
- **Regular Updates**: Keep Yopass and dependencies updated
- **Monitor Logs**: Implement proper logging and monitoring
- **Access Controls**: Restrict administrative access appropriately
- **Backup Security**: Ensure backup systems don't contain secrets
- **Network Security**: Deploy behind appropriate network security controls

### Security Advisories

Security updates are published through release notes.

## Contact Information

**Security Contact**: johan{a}haals.se

For urgent security issues, please include "SECURITY" in the email subject line.

**PGP Key**: Available on request for sensitive communications

---

I appreciate your efforts in keeping Yopass secure for everyone. Your responsible disclosure helps maintain the security and privacy that users depend on.