package server

import (
	"crypto/tls"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/smtp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// SMTP transport security modes for --smtp-tls.
const (
	SMTPTLSStartTLS = "starttls" // plain connection upgraded with STARTTLS (default)
	SMTPTLSImplicit = "tls"      // TLS from the first byte, typically port 465
	SMTPTLSNone     = "none"     // no transport security; local relays only
)

// DefaultSMTPPort is the submission port used when --smtp-port is unset.
const DefaultSMTPPort = 587

// DefaultSMTPTimeout bounds the whole send: dial, handshake and delivery.
// Verification codes are sent while the recipient waits, so this is
// deliberately short.
const DefaultSMTPTimeout = 10 * time.Second

// SMTPConfig holds the outbound mail settings used to deliver recipient
// verification codes. Yopass never sends any other mail.
type SMTPConfig struct {
	Host     string
	Port     int
	Username string
	Password string
	From     string
	TLS      string
	Timeout  time.Duration
}

// ValidSMTPTLSModes lists the accepted --smtp-tls values.
func ValidSMTPTLSModes() []string {
	return []string{SMTPTLSStartTLS, SMTPTLSImplicit, SMTPTLSNone}
}

// Mailer sends a plain-text message. The interface exists so tests can
// substitute a transport that records instead of sending; SMTP is the only
// production implementation.
type Mailer interface {
	Send(to, subject, body string) error
}

// ErrMailRateLimited is returned when the instance-wide send budget is spent.
var ErrMailRateLimited = errors.New("smtp: send rate limit reached")

// DefaultMaxMailPerHour is the instance-wide ceiling on verification emails.
//
// Creating secrets is unauthenticated by default and the per-recipient send
// budget is per secret, so without a global ceiling anyone who knows an
// address can mint secrets bound to it in a loop and have Yopass mail that
// address three times per iteration. The damage is to the operator's relay
// reputation, so the bound belongs on the relay, not on the caller — which
// also avoids the per-IP tracking this project deliberately does without.
const DefaultMaxMailPerHour = 500

// rateLimitedMailer wraps a Mailer with a fixed-window instance-wide budget.
type rateLimitedMailer struct {
	inner   Mailer
	perHour int

	mu          sync.Mutex
	windowStart time.Time
	sent        int
}

// NewRateLimitedMailer bounds how many messages inner may send per hour.
// A perHour of zero or less disables the limit.
func NewRateLimitedMailer(inner Mailer, perHour int) Mailer {
	if inner == nil || perHour <= 0 {
		return inner
	}
	return &rateLimitedMailer{inner: inner, perHour: perHour, windowStart: time.Now()}
}

// allow reserves a slot in the current window.
func (m *rateLimitedMailer) allow() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if time.Since(m.windowStart) >= time.Hour {
		m.windowStart = time.Now()
		m.sent = 0
	}
	if m.sent >= m.perHour {
		return false
	}
	m.sent++
	return true
}

// refund returns a reserved slot after a failed send.
func (m *rateLimitedMailer) refund() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sent > 0 {
		m.sent--
	}
}

func (m *rateLimitedMailer) Send(to, subject, body string) error {
	if !m.allow() {
		return ErrMailRateLimited
	}
	if err := m.inner.Send(to, subject, body); err != nil {
		m.refund()
		return err
	}
	return nil
}

// smtpMailer delivers over SMTP using the standard library.
type smtpMailer struct{ cfg SMTPConfig }

// NewSMTPMailer returns a Mailer delivering through the configured relay,
// applying defaults for port, TLS mode and timeout.
func NewSMTPMailer(cfg SMTPConfig) Mailer {
	if cfg.Port == 0 {
		cfg.Port = DefaultSMTPPort
	}
	if cfg.TLS == "" {
		cfg.TLS = SMTPTLSStartTLS
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = DefaultSMTPTimeout
	}
	return smtpMailer{cfg: cfg}
}

// headerSafe reports whether a value can be placed in a mail header without
// smuggling extra headers. Recipient addresses are validated at creation, but
// this is the last check before the wire.
func headerSafe(v string) bool {
	return !strings.ContainsAny(v, "\r\n")
}

// Send delivers a UTF-8 plain-text message to a single recipient.
func (m smtpMailer) Send(to, subject, body string) error {
	if !headerSafe(to) || !headerSafe(subject) || !headerSafe(m.cfg.From) {
		return errors.New("smtp: header value contains a line break")
	}

	addr := net.JoinHostPort(m.cfg.Host, strconv.Itoa(m.cfg.Port))
	dialer := &net.Dialer{Timeout: m.cfg.Timeout}
	tlsConfig := &tls.Config{ServerName: m.cfg.Host, MinVersion: tls.VersionTLS12}

	var conn net.Conn
	var err error
	if m.cfg.TLS == SMTPTLSImplicit {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, tlsConfig)
	} else {
		conn, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		return err
	}
	defer conn.Close()
	// One deadline for the whole exchange; every subsequent read and write
	// inherits it, so a wedged relay cannot hold the recipient's request open.
	if err := conn.SetDeadline(time.Now().Add(m.cfg.Timeout)); err != nil {
		return err
	}

	c, err := smtp.NewClient(conn, m.cfg.Host)
	if err != nil {
		return err
	}
	defer func() { _ = c.Close() }()

	if m.cfg.TLS == SMTPTLSStartTLS {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return errors.New("smtp: server does not advertise STARTTLS")
		}
		if err := c.StartTLS(tlsConfig); err != nil {
			return err
		}
	}

	if m.cfg.Username != "" {
		// PlainAuth refuses to hand over credentials on an unencrypted
		// connection unless the host is localhost — the behaviour we want.
		if err := c.Auth(smtp.PlainAuth("", m.cfg.Username, m.cfg.Password, m.cfg.Host)); err != nil {
			return err
		}
	}

	if err := c.Mail(m.cfg.From); err != nil {
		return err
	}
	if err := c.Rcpt(to); err != nil {
		return err
	}
	wc, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := wc.Write([]byte(m.message(to, subject, body))); err != nil {
		_ = wc.Close()
		return err
	}
	if err := wc.Close(); err != nil {
		return err
	}
	return c.Quit()
}

// message renders the RFC 5322 message. Auto-Submitted suppresses
// out-of-office replies and Precedence keeps the mail out of most
// auto-responder loops.
func (m smtpMailer) message(to, subject, body string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", m.cfg.From)
	fmt.Fprintf(&b, "To: %s\r\n", to)
	// --app-name can carry any UTF-8, and raw 8-bit bytes in a header are
	// rejected or mangled by strict relays. QEncoding leaves pure ASCII alone.
	fmt.Fprintf(&b, "Subject: %s\r\n", mime.QEncoding.Encode("utf-8", subject))
	fmt.Fprintf(&b, "Date: %s\r\n", time.Now().UTC().Format(time.RFC1123Z))
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
	b.WriteString("Auto-Submitted: auto-generated\r\n")
	b.WriteString("Precedence: bulk\r\n")
	b.WriteString("\r\n")
	b.WriteString(strings.ReplaceAll(body, "\n", "\r\n"))
	return b.String()
}
