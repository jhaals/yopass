package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestJSONNestedDeeperThan(t *testing.T) {
	open := func(n int) string { return strings.Repeat("[", n) }
	tt := []struct {
		name string
		body string
		want bool
	}{
		{"flat object", `{"message":"x","expiration":3600}`, false},
		{"at the limit", open(maxJSONBodyDepth) + strings.Repeat("]", maxJSONBodyDepth), false},
		{"arrays over the limit", open(maxJSONBodyDepth + 1), true},
		{"objects over the limit", strings.Repeat(`{"a":`, maxJSONBodyDepth+1), true},
		{"siblings do not add up", "[" + strings.Repeat("[],", 100) + "[]]", false},
		{"brackets in a string", `{"message":"` + open(100) + `"}`, false},
		{"escaped quote keeps the string open", `{"message":"\"` + open(100) + `"}`, false},
		{"escaped backslash ends the string", `{"message":"\\",` + open(100), true},
	}
	for _, tc := range tt {
		if got := jsonNestedDeeperThan([]byte(tc.body), maxJSONBodyDepth); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

// Deep nesting makes encoding/json recurse, megabytes of stack per request;
// every route that parses a JSON body must refuse it.
func TestDeeplyNestedBodyIsRejected(t *testing.T) {
	y := newRequestTestServer(t, newMemoryDB(), true)
	handler := y.HTTPHandler()
	nested := strings.Repeat("[", 5000) + strings.Repeat("]", 5000)
	for _, route := range []struct{ method, path string }{
		{http.MethodPost, "/create/secret"},
		{http.MethodPost, "/request"},
		{http.MethodPost, "/request/11111111-1111-1111-1111-111111111111/secret"},
		{http.MethodPut, "/request/11111111-1111-1111-1111-111111111111/key"},
	} {
		for _, body := range []string{nested, `{"x":` + nested + `}`} {
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, httptest.NewRequest(route.method, route.path, strings.NewReader(body)))
			if rr.Code != http.StatusBadRequest || !strings.Contains(rr.Body.String(), "Unable to parse json") {
				t.Errorf("%s %s: got %d %q, want 400 Unable to parse json", route.method, route.path, rr.Code, rr.Body.String())
			}
		}
	}
}
