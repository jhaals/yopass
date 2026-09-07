package server

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/textproto"
	"strings"
	"testing"
	"time"
)

// smtpTestRelay accepts one connection, with bounded I/O even when a test fails.
func smtpTestRelay(t *testing.T, serve func(*textproto.Conn) error) SMTPConfig {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			done <- err
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		done <- serve(textproto.NewConn(conn))
	}()
	t.Cleanup(func() {
		listener.Close()
		if err := <-done; err != nil {
			t.Errorf("SMTP relay: %v", err)
		}
	})
	return SMTPConfig{
		Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port,
		From: "yopass@example.com", TLS: SMTPTLSNone, Timeout: 2 * time.Second,
	}
}

func TestSMTPAcceptedMessageSurvivesQuitFailure(t *testing.T) {
	for _, quitFails := range []bool{false, true} {
		t.Run(fmt.Sprintf("quitFails=%t", quitFails), func(t *testing.T) {
			cfg := smtpTestRelay(t, func(c *textproto.Conn) error {
				if err := c.PrintfLine("220 test relay"); err != nil {
					return err
				}
				for _, exchange := range []struct{ command, reply string }{
					{"EHLO localhost", "250 test relay"},
					{"MAIL FROM:<yopass@example.com>", "250 OK"},
					{"RCPT TO:<alice@example.com>", "250 OK"},
					{"DATA", "354 send message"},
				} {
					line, err := c.ReadLine()
					if err != nil {
						return err
					}
					if line != exchange.command {
						return fmt.Errorf("got %q, want %q", line, exchange.command)
					}
					if err := c.PrintfLine("%s", exchange.reply); err != nil {
						return err
					}
				}
				data, err := c.ReadDotBytes()
				if err != nil {
					return err
				}
				if strings.Contains(string(data), "alice@example.com") || !strings.Contains(string(data), "Your code is: 123456") {
					return fmt.Errorf("unexpected message content: %q", data)
				}
				if err := c.PrintfLine("250 queued"); err != nil {
					return err
				}
				line, err := c.ReadLine()
				if err != nil || line != "QUIT" {
					return fmt.Errorf("expected QUIT, got %q: %v", line, err)
				}
				if quitFails {
					return nil // Close after accepting DATA, without a QUIT reply.
				}
				return c.PrintfLine("221 bye")
			})
			mailer := NewRateLimitedMailer(NewSMTPMailer(cfg), 1)
			if err := mailer.Send(" Alice@Example.COM ", "Verification code", "Your code is: 123456"); err != nil {
				t.Fatalf("accepted message reported as failed: %v", err)
			}
			if err := mailer.Send("alice@example.com", "subject", "body"); !errors.Is(err, ErrMailRateLimited) {
				t.Fatalf("accepted message was refunded: %v", err)
			}
		})
	}
}

func TestSMTPRequiresSTARTTLS(t *testing.T) {
	cfg := smtpTestRelay(t, func(c *textproto.Conn) error {
		if err := c.PrintfLine("220 test relay"); err != nil {
			return err
		}
		if _, err := c.ReadLine(); err != nil {
			return err
		}
		if err := c.PrintfLine("250 test relay without STARTTLS"); err != nil {
			return err
		}
		if line, err := c.ReadLine(); err != io.EOF {
			return fmt.Errorf("client continued without TLS: %q, %v", line, err)
		}
		return nil
	})
	cfg.TLS = SMTPTLSStartTLS
	if err := NewSMTPMailer(cfg).Send("alice@example.com", "subject", "body"); err == nil || !strings.Contains(err.Error(), "STARTTLS") {
		t.Fatalf("expected refusal when STARTTLS is absent, got %v", err)
	}
}

func TestSMTPRejectsUnsafeInputBeforeDial(t *testing.T) {
	for _, tc := range []struct{ to, from, subject, mode string }{
		{"a@example.com\r\nBcc: victim@example.com", "s@example.com", "subject", SMTPTLSNone},
		{"a@example.com", "s@example.com\r\nBcc: victim@example.com", "subject", SMTPTLSNone},
		{"a@example.com", "s@example.com", "subject\nBcc: victim@example.com", SMTPTLSNone},
		{"a@example.com,b@example.com", "s@example.com", "subject", SMTPTLSNone},
		{"ü@example.com", "s@example.com", "subject", SMTPTLSNone},
		{"a@example.com", "s@example.com", "subject", "starttIs"},
	} {
		m := NewSMTPMailer(SMTPConfig{From: tc.from, TLS: tc.mode})
		err := m.Send(tc.to, tc.subject, "body")
		if err == nil || !strings.HasPrefix(err.Error(), "smtp:") {
			t.Errorf("input reached dial: %+v: %v", tc, err)
		}
	}
}

func TestRateLimitedMailerDoesNotRefundNewWindow(t *testing.T) {
	var m *rateLimitedMailer
	calls := 0
	m = NewRateLimitedMailer(mailerFunc(func(to, subject, body string) error {
		calls++
		if calls == 1 {
			// A send from the old window is still in flight when the next
			// window starts and its only slot is consumed successfully.
			m.mu.Lock()
			m.windowStart = time.Now().Add(-time.Hour)
			m.mu.Unlock()
			if err := m.Send(to, subject, body); err != nil {
				t.Fatal(err)
			}
			return errors.New("old send failed")
		}
		return nil
	}), 1).(*rateLimitedMailer)
	if err := m.Send("a@example.com", "subject", "body"); err == nil {
		t.Fatal("expected old send to fail")
	}
	if err := m.Send("a@example.com", "subject", "body"); !errors.Is(err, ErrMailRateLimited) {
		t.Fatalf("old failure refunded a new window's slot: %v", err)
	}
}
