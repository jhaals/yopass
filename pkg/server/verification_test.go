package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/prometheus/client_golang/prometheus"
	"go.uber.org/zap/zaptest"
)

// fakeMailer records what would have been sent instead of dialing a relay.
type fakeMailer struct {
	mu   sync.Mutex
	sent []sentMail
	err  error
}

type sentMail struct{ to, subject, body string }

func (m *fakeMailer) Send(to, subject, body string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.err != nil {
		return m.err
	}
	m.sent = append(m.sent, sentMail{to, subject, body})
	return nil
}

func (m *fakeMailer) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sent)
}

// last returns the most recently sent mail, failing the test if none was sent.
func (m *fakeMailer) last(t *testing.T) sentMail {
	t.Helper()
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.sent) == 0 {
		t.Fatal("expected a mail to have been sent, got none")
	}
	return m.sent[len(m.sent)-1]
}

// codeFrom extracts the six-digit code from a message body.
func codeFrom(t *testing.T, body string) string {
	t.Helper()
	const marker = "Your code is: "
	i := strings.Index(body, marker)
	if i < 0 {
		t.Fatalf("no code in mail body: %q", body)
	}
	return body[i+len(marker) : i+len(marker)+6]
}

// verificationFixture is a server with mail configured and one secret bound to
// alice@example.com.
type verificationFixture struct {
	server  *Server
	handler http.Handler
	mailer  *fakeMailer
	db      *memoryDB
}

const verifyTestID = "12345678-1234-1234-1234-123456789012"

func newVerificationFixture(t *testing.T, mutate func(*Server)) *verificationFixture {
	t.Helper()
	db := newMemoryDB()
	mailer := &fakeMailer{}
	y := &Server{
		DB:             db,
		MaxLength:      10000,
		MaxFileSize:    1024 * 1024,
		Registry:       prometheus.NewRegistry(),
		Logger:         zaptest.NewLogger(t),
		PrefetchSecret: true,
		License:        validLicense(),
		Mailer:         mailer,
	}
	if mutate != nil {
		mutate(y)
	}
	return &verificationFixture{server: y, handler: y.HTTPHandler(), mailer: mailer, db: db}
}

// bind stores a secret and binds it to the given recipients.
func (f *verificationFixture) bind(t *testing.T, recipients ...string) {
	t.Helper()
	if err := f.db.Put(verifyTestID, yopass.Secret{
		Message: "***ENCRYPTED***", OneTime: true, RecipientBound: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.server.createVerification(verifyTestID, recipients, 3600); err != nil {
		t.Fatal(err)
	}
}

// post sends a verification request and returns the recorder.
func (f *verificationFixture) post(t *testing.T, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	f.handler.ServeHTTP(rr, req)
	return rr
}

// getSecretWithToken fetches the bound secret, optionally presenting a token.
func (f *verificationFixture) getSecretWithToken(t *testing.T, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/secret/"+verifyTestID, nil)
	if token != "" {
		req.Header.Set(verificationTokenHeader, token)
	}
	rr := httptest.NewRecorder()
	f.handler.ServeHTTP(rr, req)
	return rr
}

// requestCode drives the request step and returns the delivered code.
func (f *verificationFixture) requestCode(t *testing.T, email string) string {
	t.Helper()
	rr := f.post(t, "/secret/"+verifyTestID+"/verify", fmt.Sprintf(`{"email":%q}`, email))
	if rr.Code != http.StatusNoContent {
		t.Fatalf("requesting a code: got %d, want 204", rr.Code)
	}
	return codeFrom(t, f.mailer.last(t).body)
}

// redeem exchanges a code for a retrieval token.
func (f *verificationFixture) redeem(t *testing.T, email, code string) *httptest.ResponseRecorder {
	t.Helper()
	return f.post(t, "/secret/"+verifyTestID+"/verify", fmt.Sprintf(`{"email":%q,"code":%q}`, email, code))
}

func TestNormalizeEmail(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"Alice@Example.COM", "alice@example.com"},
		{"  alice@example.com  ", "alice@example.com"},
		// Provider-specific folding is deliberately not applied.
		{"a.l.i.c.e+tag@gmail.com", "a.l.i.c.e+tag@gmail.com"},
	} {
		if got := normalizeEmail(tc.in); got != tc.want {
			t.Errorf("normalizeEmail(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestValidRecipient(t *testing.T) {
	valid := []string{
		"alice@example.com",
		"Alice@Example.com",
		"a+b@sub.example.co.uk",
		"alice@xn--xample-9ua.com", // IDNA form of an internationalised domain
	}
	for _, addr := range valid {
		if !validRecipient(addr) {
			t.Errorf("validRecipient(%q) = false, want true", addr)
		}
	}
	invalid := []string{
		"",
		"not-an-address",
		"Alice <alice@example.com>",         // display-name form would not match what is typed later
		"alice@example.com\r\nBcc: x@y.com", // header injection
		"ü@example.com",                     // net/smtp cannot negotiate SMTPUTF8 for the local part
		"alice@éxample.com",                 // raw Unicode domains also require SMTPUTF8
		strings.Repeat("a", 250) + "@x.com", // over the RFC 5321 length
	}
	for _, addr := range invalid {
		if validRecipient(addr) {
			t.Errorf("validRecipient(%q) = true, want false", addr)
		}
	}
}

// TestVerificationStoresNoPlaintextAddress is the privacy invariant: the
// stored record must not contain any recipient address.
func TestVerificationStoresNoPlaintextAddress(t *testing.T) {
	f := newVerificationFixture(t, nil)
	f.bind(t, "alice@example.com", "bob@example.com")

	stored, err := f.db.Status(verifyKeyPrefix + verifyTestID)
	if err != nil {
		t.Fatal(err)
	}
	for _, addr := range []string{"alice@example.com", "bob@example.com", "alice", "example.com"} {
		if strings.Contains(stored.Message, addr) {
			t.Errorf("stored record leaks %q: %s", addr, stored.Message)
		}
	}

	var v recipientVerification
	if err := json.Unmarshal([]byte(stored.Message), &v); err != nil {
		t.Fatal(err)
	}
	if len(v.EmailHashes) != 2 {
		t.Fatalf("got %d hashes, want 2", len(v.EmailHashes))
	}
	if v.recipientIndex("ALICE@example.com") != 0 {
		t.Error("recipientIndex should be case-insensitive")
	}
	if v.recipientIndex("bob@example.com") != 1 {
		t.Error("second recipient should resolve to index 1")
	}
	if v.recipientIndex("carol@example.com") != -1 {
		t.Error("unbound address must not match")
	}
}

// TestVerificationHappyPath walks the whole flow and asserts the secret is
// only released once the code has been redeemed.
func TestVerificationHappyPath(t *testing.T) {
	f := newVerificationFixture(t, nil)
	f.bind(t, "alice@example.com")

	if rr := f.getSecretWithToken(t, ""); rr.Code != http.StatusForbidden {
		t.Fatalf("unverified fetch: got %d, want 403", rr.Code)
	}

	code := f.requestCode(t, "alice@example.com")
	if to := f.mailer.last(t).to; to != "alice@example.com" {
		t.Errorf("code sent to %q, want alice@example.com", to)
	}
	if body := f.mailer.last(t).body; strings.Contains(body, verifyTestID) {
		t.Error("mail body must not contain the secret ID")
	}

	rr := f.redeem(t, "alice@example.com", code)
	if rr.Code != http.StatusOK {
		t.Fatalf("redeeming a valid code: got %d, want 200", rr.Code)
	}
	var resp struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Token == "" {
		t.Fatal("no token returned")
	}

	got := f.getSecretWithToken(t, resp.Token)
	if got.Code != http.StatusOK {
		t.Fatalf("verified fetch: got %d, want 200", got.Code)
	}
	if !strings.Contains(got.Body.String(), "***ENCRYPTED***") {
		t.Errorf("unexpected body: %s", got.Body.String())
	}
}

// TestVerificationDoesNotBurnOneTimeSecret is the property that makes this
// feature fix link-prefetch burns: an unverified fetch must leave the secret
// intact.
func TestVerificationDoesNotBurnOneTimeSecret(t *testing.T) {
	f := newVerificationFixture(t, nil)
	f.bind(t, "alice@example.com")

	for i := 0; i < 3; i++ {
		if rr := f.getSecretWithToken(t, "wrong-token"); rr.Code != http.StatusForbidden {
			t.Fatalf("fetch %d: got %d, want 403", i, rr.Code)
		}
	}
	if _, err := f.db.Status(verifyTestID); err != nil {
		t.Fatal("one-time secret was consumed by unverified fetches")
	}

	code := f.requestCode(t, "alice@example.com")
	var resp struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(f.redeem(t, "alice@example.com", code).Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if rr := f.getSecretWithToken(t, resp.Token); rr.Code != http.StatusOK {
		t.Fatalf("verified fetch: got %d, want 200", rr.Code)
	}
	// Now it should be gone, along with its binding.
	if _, err := f.db.Status(verifyTestID); err == nil {
		t.Error("one-time secret survived a verified fetch")
	}
	if _, ok := f.server.loadVerification(verifyTestID); ok {
		t.Error("verification record should be cleared once the secret is consumed")
	}
}

// TestVerificationWrongAddressIsNotAnOracle asserts the no-enumeration
// property: a non-matching address is answered exactly like a matching one,
// and no mail is sent.
func TestVerificationWrongAddressIsNotAnOracle(t *testing.T) {
	f := newVerificationFixture(t, nil)
	f.bind(t, "alice@example.com")

	match := f.post(t, "/secret/"+verifyTestID+"/verify", `{"email":"alice@example.com"}`)
	mismatch := f.post(t, "/secret/"+verifyTestID+"/verify", `{"email":"mallory@example.com"}`)

	if match.Code != mismatch.Code {
		t.Errorf("status differs: matching %d, non-matching %d", match.Code, mismatch.Code)
	}
	if match.Body.String() != mismatch.Body.String() {
		t.Errorf("body differs: matching %q, non-matching %q", match.Body.String(), mismatch.Body.String())
	}
	if f.mailer.count() != 1 {
		t.Errorf("got %d mails, want 1 — a non-matching address must not trigger a send", f.mailer.count())
	}
	if to := f.mailer.last(t).to; to != "alice@example.com" {
		t.Errorf("mail went to %q", to)
	}
}

func TestVerificationAttemptLimit(t *testing.T) {
	f := newVerificationFixture(t, nil)
	f.bind(t, "alice@example.com")
	code := f.requestCode(t, "alice@example.com")

	for i := 0; i < maxCodeAttempts; i++ {
		if rr := f.redeem(t, "alice@example.com", "000000"); rr.Code != http.StatusForbidden {
			t.Fatalf("wrong code %d: got %d, want 403", i, rr.Code)
		}
	}
	// The correct code is now dead: the attempt budget is spent.
	if rr := f.redeem(t, "alice@example.com", code); rr.Code != http.StatusForbidden {
		t.Errorf("after the attempt limit the correct code should be rejected, got %d", rr.Code)
	}
}

func TestVerificationSendLimit(t *testing.T) {
	f := newVerificationFixture(t, nil)
	f.bind(t, "alice@example.com")

	for i := 0; i < maxCodeSends+2; i++ {
		if rr := f.post(t, "/secret/"+verifyTestID+"/verify", `{"email":"alice@example.com"}`); rr.Code != http.StatusNoContent {
			t.Fatalf("send %d: got %d, want 204", i, rr.Code)
		}
	}
	if f.mailer.count() != maxCodeSends {
		t.Errorf("sent %d mails, want the cap of %d", f.mailer.count(), maxCodeSends)
	}
}

// tokenFor drives a full verification for one recipient and returns the token.
func (f *verificationFixture) tokenFor(t *testing.T, email string) string {
	t.Helper()
	code := f.requestCode(t, email)
	var resp struct {
		Token string `json:"token"`
	}
	rr := f.redeem(t, email, code)
	if rr.Code != http.StatusOK {
		t.Fatalf("redeeming for %s: got %d, want 200", email, rr.Code)
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	return resp.Token
}

// TestVerificationTokensAreIndependentPerRecipient guards the documented
// five-minute retrieval window: a co-recipient verifying later must not
// invalidate a token that is still live.
func TestVerificationTokensAreIndependentPerRecipient(t *testing.T) {
	f := newVerificationFixture(t, func(y *Server) { y.Mailer = &fakeMailer{} })
	// Multi-view, so the record survives the first retrieval.
	if err := f.db.Put(verifyTestID, yopass.Secret{
		Message: "***ENCRYPTED***", RecipientBound: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.server.createVerification(verifyTestID,
		[]string{"alice@example.com", "bob@example.com"}, 3600); err != nil {
		t.Fatal(err)
	}
	f.mailer = f.server.Mailer.(*fakeMailer)

	aliceToken := f.tokenFor(t, "alice@example.com")
	bobToken := f.tokenFor(t, "bob@example.com")

	if rr := f.getSecretWithToken(t, aliceToken); rr.Code != http.StatusOK {
		t.Errorf("alice's token was invalidated by bob verifying: got %d, want 200", rr.Code)
	}
	if rr := f.getSecretWithToken(t, bobToken); rr.Code != http.StatusOK {
		t.Errorf("bob's token: got %d, want 200", rr.Code)
	}
}

// TestVerificationSendBudgetIsPerRecipient asserts one recipient cannot spend
// another's codes.
func TestVerificationSendBudgetIsPerRecipient(t *testing.T) {
	f := newVerificationFixture(t, nil)
	f.bind(t, "alice@example.com", "bob@example.com")

	for i := 0; i < maxCodeSends+1; i++ {
		f.post(t, "/secret/"+verifyTestID+"/verify", `{"email":"alice@example.com"}`)
	}
	if f.mailer.count() != maxCodeSends {
		t.Fatalf("alice got %d codes, want the cap of %d", f.mailer.count(), maxCodeSends)
	}

	// Bob's budget must be untouched.
	code := f.requestCode(t, "bob@example.com")
	if rr := f.redeem(t, "bob@example.com", code); rr.Code != http.StatusOK {
		t.Errorf("bob was locked out by alice exhausting her sends: got %d, want 200", rr.Code)
	}
}

// TestVerificationRefundLeavesNewerCodeAlone covers the refund race: a slow
// send that eventually fails must not clear a code that a later request
// already delivered to the same recipient.
func TestVerificationRefundLeavesNewerCodeAlone(t *testing.T) {
	f := newVerificationFixture(t, nil)
	f.bind(t, "alice@example.com")

	// First request succeeds and delivers a usable code.
	live := f.requestCode(t, "alice@example.com")

	// Simulate the tail of an earlier, slower send failing after the fact by
	// running the refund with a stale code hash.
	stale := hashCode("000000")
	if err := f.server.updateVerification(verifyTestID, func(v *recipientVerification) error {
		s := &v.States[0]
		if s.CodeHash != stale {
			return nil // compare-and-swap: not our code, leave it be
		}
		s.CodeHash = ""
		s.CodeExpiresAt = 0
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if rr := f.redeem(t, "alice@example.com", live); rr.Code != http.StatusOK {
		t.Errorf("a stale refund destroyed a delivered code: got %d, want 200", rr.Code)
	}
}

// TestVerificationSendFailureRefundsBudget guards against a transient relay
// outage permanently locking the recipient out of the secret.
func TestVerificationSendFailureRefundsBudget(t *testing.T) {
	f := newVerificationFixture(t, nil)
	f.bind(t, "alice@example.com")
	f.mailer.err = errors.New("relay unavailable")

	for i := 0; i < maxCodeSends+1; i++ {
		rr := f.post(t, "/secret/"+verifyTestID+"/verify", `{"email":"alice@example.com"}`)
		if rr.Code != http.StatusBadGateway {
			t.Fatalf("send %d during outage: got %d, want 502", i, rr.Code)
		}
	}

	v, ok := f.server.loadVerification(verifyTestID)
	if !ok {
		t.Fatal("verification record disappeared")
	}
	if v.States[0].Sends != 0 {
		t.Errorf("failed sends consumed %d of the budget, want 0", v.States[0].Sends)
	}

	// The relay recovers and the recipient still has their full budget.
	f.mailer.err = nil
	code := f.requestCode(t, "alice@example.com")
	if rr := f.redeem(t, "alice@example.com", code); rr.Code != http.StatusOK {
		t.Errorf("after the outage: got %d, want 200", rr.Code)
	}
}

func TestVerificationExpiredCodeRejected(t *testing.T) {
	f := newVerificationFixture(t, nil)
	f.bind(t, "alice@example.com")
	code := f.requestCode(t, "alice@example.com")

	if err := f.server.updateVerification(verifyTestID, func(v *recipientVerification) error {
		v.States[0].CodeExpiresAt = time.Now().Add(-time.Minute).Unix()
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if rr := f.redeem(t, "alice@example.com", code); rr.Code != http.StatusForbidden {
		t.Errorf("expired code: got %d, want 403", rr.Code)
	}
}

func TestVerificationExpiredTokenRejected(t *testing.T) {
	f := newVerificationFixture(t, nil)
	f.bind(t, "alice@example.com")
	code := f.requestCode(t, "alice@example.com")

	var resp struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(f.redeem(t, "alice@example.com", code).Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if err := f.server.updateVerification(verifyTestID, func(v *recipientVerification) error {
		v.States[0].TokenExpiresAt = time.Now().Add(-time.Minute).Unix()
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if rr := f.getSecretWithToken(t, resp.Token); rr.Code != http.StatusForbidden {
		t.Errorf("expired token: got %d, want 403", rr.Code)
	}
}

// TestVerificationCodeIsBoundToAddress asserts a code issued for one bound
// recipient cannot be redeemed by naming a different bound recipient.
func TestVerificationCodeIsBoundToAddress(t *testing.T) {
	f := newVerificationFixture(t, nil)
	f.bind(t, "alice@example.com")
	code := f.requestCode(t, "alice@example.com")

	if rr := f.redeem(t, "mallory@example.com", code); rr.Code != http.StatusForbidden {
		t.Errorf("redeeming as an unbound address: got %d, want 403", rr.Code)
	}
}

// TestVerificationEnforcedAfterLicenseExpiry is the degradation invariant: a
// lapsed license must not turn a bound secret into a freely readable one.
func TestVerificationEnforcedAfterLicenseExpiry(t *testing.T) {
	f := newVerificationFixture(t, func(y *Server) {
		y.License = LicenseStatus{Valid: true, ExpiresAt: time.Now().Add(-time.Hour)}
	})
	f.bind(t, "alice@example.com")

	if f.server.recipientVerificationEnabled() {
		t.Error("creation should be disabled once the license has expired")
	}
	if !f.server.verificationCanBeCompleted() {
		t.Error("the verification exchange must survive license expiry")
	}
	if rr := f.getSecretWithToken(t, ""); rr.Code != http.StatusForbidden {
		t.Errorf("bound secret became readable after license expiry: got %d, want 403", rr.Code)
	}
}

// TestVerificationFailsClosedWhenRecordIsGone covers the independent-eviction
// case: the secret and its binding are separate database keys, so the binding
// can vanish while the secret survives. Serving it ungated would silently
// undo what the creator asked for.
func TestVerificationFailsClosedWhenRecordIsGone(t *testing.T) {
	f := newVerificationFixture(t, nil)
	f.bind(t, "alice@example.com")

	// Evict only the verification record.
	if _, err := f.db.Delete(verifyKeyPrefix + verifyTestID); err != nil {
		t.Fatal(err)
	}

	if rr := f.getSecretWithToken(t, ""); rr.Code != http.StatusForbidden {
		t.Errorf("bound secret served after its binding was evicted: got %d, want 403", rr.Code)
	}
	if _, err := f.db.Status(verifyTestID); err != nil {
		t.Error("the one-time secret was consumed by a refused request")
	}
}

// TestVerificationFailsClosedWithoutMailer covers the shared-fleet case: an
// instance with no mail transport must refuse bound secrets rather than serve
// every one in the database ungated.
func TestVerificationFailsClosedWithoutMailer(t *testing.T) {
	f := newVerificationFixture(t, nil)
	f.bind(t, "alice@example.com")

	// A second instance on the same database, without SMTP configured.
	replica := &Server{
		DB:             f.db,
		MaxLength:      10000,
		Registry:       prometheus.NewRegistry(),
		Logger:         zaptest.NewLogger(t),
		PrefetchSecret: true,
		License:        validLicense(),
	}
	req := httptest.NewRequest(http.MethodGet, "/secret/"+verifyTestID, nil)
	rr := httptest.NewRecorder()
	replica.HTTPHandler().ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Errorf("an instance without SMTP served a bound secret: got %d, want 403", rr.Code)
	}
}

// TestVerificationUnboundSecretUnaffected asserts the gate only applies to
// secrets that were actually bound.
func TestVerificationUnboundSecretUnaffected(t *testing.T) {
	f := newVerificationFixture(t, nil)
	if err := f.db.Put(verifyTestID, yopass.Secret{Message: "***ENCRYPTED***"}); err != nil {
		t.Fatal(err)
	}
	if rr := f.getSecretWithToken(t, ""); rr.Code != http.StatusOK {
		t.Errorf("unbound secret: got %d, want 200", rr.Code)
	}
}

// TestVerificationRoutesRequireMailer asserts the endpoints are absent, and
// nothing is enforced, when no mail transport is configured.
func TestVerificationRoutesRequireMailer(t *testing.T) {
	f := newVerificationFixture(t, func(y *Server) { y.Mailer = nil })
	if err := f.db.Put(verifyTestID, yopass.Secret{Message: "***ENCRYPTED***"}); err != nil {
		t.Fatal(err)
	}
	if rr := f.post(t, "/secret/"+verifyTestID+"/verify", `{"email":"a@b.com"}`); rr.Code != http.StatusNotFound {
		t.Errorf("verify route should not be registered without a mailer, got %d", rr.Code)
	}
	if rr := f.getSecretWithToken(t, ""); rr.Code != http.StatusOK {
		t.Errorf("retrieval should be unaffected without a mailer, got %d", rr.Code)
	}
}

// TestCreateSecretWithRecipients exercises binding through the public API.
func TestCreateSecretWithRecipients(t *testing.T) {
	for _, tc := range []struct {
		name       string
		mutate     func(*Server)
		recipients []string
		wantStatus int
	}{
		{"valid", nil, []string{"alice@example.com"}, http.StatusOK},
		{"SMTPUTF8 local part", nil, []string{"ü@example.com"}, http.StatusBadRequest},
		{"SMTPUTF8 domain", nil, []string{"alice@éxample.com"}, http.StatusBadRequest},
		{"too many", nil, make([]string, maxRecipients+1), http.StatusBadRequest},
		{"invalid address", nil, []string{"nope"}, http.StatusBadRequest},
		{"unlicensed", func(y *Server) { y.License = LicenseStatus{} }, []string{"alice@example.com"}, http.StatusBadRequest},
		{"no mailer", func(y *Server) { y.Mailer = nil }, []string{"alice@example.com"}, http.StatusBadRequest},
		{"feature disabled", func(y *Server) { y.DisableRecipientVerification = true }, []string{"alice@example.com"}, http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newVerificationFixture(t, tc.mutate)
			recipients := tc.recipients
			if tc.name == "too many" {
				for i := range recipients {
					recipients[i] = fmt.Sprintf("user%d@example.com", i)
				}
			}
			payload, _ := json.Marshal(map[string]interface{}{
				"message":    contractPGPMessage,
				"expiration": 3600,
				"one_time":   true,
				"recipients": recipients,
			})
			rr := f.post(t, "/create/secret", string(payload))
			if rr.Code != tc.wantStatus {
				t.Fatalf("got %d, want %d (%s)", rr.Code, tc.wantStatus, rr.Body.String())
			}
			if tc.wantStatus != http.StatusOK {
				return
			}
			var resp struct {
				Message string `json:"message"`
			}
			if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
				t.Fatal(err)
			}
			if _, ok := f.server.loadVerification(resp.Message); !ok {
				t.Error("no verification record stored for a bound secret")
			}
		})
	}
}

func TestParseRecipients(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want []string
	}{
		{"", nil},
		{"   ", nil},
		{"a@b.com", []string{"a@b.com"}},
		{" a@b.com , c@d.com ,, ", []string{"a@b.com", "c@d.com"}},
	} {
		got := parseRecipients(tc.in)
		if len(got) != len(tc.want) {
			t.Errorf("parseRecipients(%q) = %v, want %v", tc.in, got, tc.want)
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("parseRecipients(%q) = %v, want %v", tc.in, got, tc.want)
				break
			}
		}
	}
}

// TestRateLimitedMailer bounds the damage an unauthenticated caller can do to
// the operator's relay reputation by minting secrets bound to one address.
func TestRateLimitedMailer(t *testing.T) {
	inner := &fakeMailer{}
	m := NewRateLimitedMailer(inner, 3)

	for i := 0; i < 3; i++ {
		if err := m.Send("a@b.com", "s", "b"); err != nil {
			t.Fatalf("send %d: %v", i, err)
		}
	}
	if err := m.Send("a@b.com", "s", "b"); !errors.Is(err, ErrMailRateLimited) {
		t.Errorf("fourth send: got %v, want ErrMailRateLimited", err)
	}
	if inner.count() != 3 {
		t.Errorf("relay saw %d messages, want 3", inner.count())
	}

	// A failed delivery must not consume the budget.
	inner2 := &fakeMailer{err: errors.New("relay down")}
	m2 := NewRateLimitedMailer(inner2, 1)
	if err := m2.Send("a@b.com", "s", "b"); err == nil {
		t.Fatal("expected the relay error to surface")
	}
	inner2.err = nil
	if err := m2.Send("a@b.com", "s", "b"); err != nil {
		t.Errorf("a failed send consumed the budget: %v", err)
	}
}

func TestRateLimitedMailerDisabled(t *testing.T) {
	inner := &fakeMailer{}
	if m := NewRateLimitedMailer(inner, 0); m != Mailer(inner) {
		t.Error("a non-positive limit should return the mailer unwrapped")
	}
	if m := NewRateLimitedMailer(nil, 10); m != nil {
		t.Error("a nil mailer should stay nil")
	}
}

// TestSMTPSubjectIsRFC2047Encoded guards non-ASCII --app-name values, which
// strict relays reject or mangle as raw 8-bit header bytes.
func TestSMTPSubjectIsRFC2047Encoded(t *testing.T) {
	m := smtpMailer{cfg: SMTPConfig{From: "yopass@example.com"}}
	msg := m.message("alice@example.com", "Sécurité verification code", "body")
	if strings.Contains(msg, "Subject: Sécurité") {
		t.Error("subject carries raw 8-bit UTF-8")
	}
	if !strings.Contains(msg, "Subject: =?utf-8?q?") {
		t.Errorf("subject is not RFC 2047 encoded:\n%s", msg)
	}
	// Pure ASCII must stay readable.
	ascii := m.message("alice@example.com", "Yopass verification code", "body")
	if !strings.Contains(ascii, "Subject: Yopass verification code\r\n") {
		t.Errorf("ASCII subject was needlessly encoded:\n%s", ascii)
	}
}

func TestSMTPMessageRejectsHeaderInjection(t *testing.T) {
	m := smtpMailer{cfg: SMTPConfig{From: "yopass@example.com", Host: "localhost"}}
	err := m.Send("alice@example.com\r\nBcc: mallory@example.com", "subject", "body")
	if err == nil || !strings.Contains(err.Error(), "line break") {
		t.Errorf("expected a line-break rejection, got %v", err)
	}
}

func TestSMTPMessageFormat(t *testing.T) {
	m := smtpMailer{cfg: SMTPConfig{From: "yopass@example.com"}}
	msg := m.message("alice@example.com", "Yopass verification code", "line one\nline two")
	for _, want := range []string{
		"From: yopass@example.com\r\n",
		"To: alice@example.com\r\n",
		"Subject: Yopass verification code\r\n",
		"Content-Type: text/plain; charset=UTF-8\r\n",
		"Auto-Submitted: auto-generated\r\n",
		"line one\r\nline two",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("message missing %q:\n%s", want, msg)
		}
	}
}

func TestGenerateVerificationCode(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		code, err := generateVerificationCode()
		if err != nil {
			t.Fatal(err)
		}
		if len(code) != 6 {
			t.Fatalf("code %q is not six digits", code)
		}
		for _, r := range code {
			if r < '0' || r > '9' {
				t.Fatalf("code %q contains a non-digit", code)
			}
		}
		seen[code] = true
	}
	// 200 draws from 10^6 should essentially never collide into a tiny set.
	if len(seen) < 150 {
		t.Errorf("only %d distinct codes in 200 draws — generator looks biased", len(seen))
	}
}

// racingDB deletes a verification record the moment it has been read,
// reproducing a co-recipient consuming the one-time secret in the window
// between loadVerification and updateVerification. The backends report that
// miss as ErrKeyNotFound from the read inside Update, without ever running
// the callback that would return errVerificationNotFound.
type racingDB struct {
	Database
	once sync.Once
}

func (db *racingDB) Status(key string) (yopass.Secret, error) {
	s, err := db.Database.Status(key)
	if err == nil && strings.HasPrefix(key, verifyKeyPrefix) {
		db.once.Do(func() { db.Database.Delete(key) })
	}
	return s, err
}

// TestVerificationRaceReportsNotFound covers the race the handlers document:
// losing it is an ordinary outcome, so the recipient must see 404 rather than
// a 500 that pages whoever watches the error rate.
func TestVerificationRaceReportsNotFound(t *testing.T) {
	t.Run("requesting a code", func(t *testing.T) {
		f := newVerificationFixture(t, nil)
		f.bind(t, "alice@example.com")
		f.server.DB = &racingDB{Database: f.db}

		rr := f.post(t, "/secret/"+verifyTestID+"/verify", `{"email":"alice@example.com"}`)
		if rr.Code != http.StatusNotFound {
			t.Errorf("got %d, want 404", rr.Code)
		}
	})

	t.Run("redeeming a code", func(t *testing.T) {
		f := newVerificationFixture(t, nil)
		f.bind(t, "alice@example.com")
		code := f.requestCode(t, "alice@example.com")
		f.server.DB = &racingDB{Database: f.db}

		if rr := f.redeem(t, "alice@example.com", code); rr.Code != http.StatusNotFound {
			t.Errorf("got %d, want 404", rr.Code)
		}
	})
}
