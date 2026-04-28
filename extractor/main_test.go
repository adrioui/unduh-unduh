package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
)

func testEnv(key, val string) func() {
	orig := os.Getenv(key)
	os.Setenv(key, val)
	return func() { os.Setenv(key, orig) }
}

func TestInferMediaType(t *testing.T) {
	tests := []struct{ ext, want string }{
		{"mp4", "video"},
		{"webm", "video"},
		{"mp3", "audio"},
		{"m4a", "audio"},
		{"jpg", "photo"},
		{"png", "photo"},
		{"xyz", ""},
	}
	for _, tt := range tests {
		if got := inferMediaType(tt.ext); got != tt.want {
			t.Errorf("inferMediaType(%q) = %q, want %q", tt.ext, got, tt.want)
		}
	}
}

func TestInferContentType(t *testing.T) {
	tests := []struct{ fn, want string }{
		{"video.mp4", "video/mp4"},
		{"audio.mp3", "audio/mpeg"},
		{"image.jpg", "image/jpeg"},
		{"image.jpeg", "image/jpeg"},
		{"image.png", "image/png"},
		{"image.webp", "image/webp"},
		{"video.webm", "video/webm"},
		{"audio.m4a", "audio/mp4"},
		{"unknown.xyz", "application/octet-stream"},
	}
	for _, tt := range tests {
		if got := inferContentType(tt.fn); got != tt.want {
			t.Errorf("inferContentType(%q) = %q, want %q", tt.fn, got, tt.want)
		}
	}
}

func TestBuildContentDisposition(t *testing.T) {
	cd := buildContentDisposition("video.mp4")
	if !strings.Contains(cd, `attachment`) {
		t.Errorf("missing attachment in: %s", cd)
	}
	if !strings.Contains(cd, `filename="video.mp4"`) {
		t.Errorf("missing filename in: %s", cd)
	}
}

func TestSanitizeDownloadFilename(t *testing.T) {
	if got := sanitizeDownloadFilename(`../nested/clip"bad.mp4`); got != "clip_bad.mp4" {
		t.Fatalf("sanitizeDownloadFilename path = %q", got)
	}
	if got := sanitizeDownloadFilename("... "); got != "" {
		t.Fatalf("sanitizeDownloadFilename dots = %q, want empty", got)
	}
}

func TestPublicDirectURLSafety(t *testing.T) {
	if !isPublicDirectURLSafe("https://cdn.example/clip.mp4", map[string]string{"User-Agent": "agent"}) {
		t.Fatal("expected https URL with public headers to be safe")
	}
	if isPublicDirectURLSafe("http://cdn.example/clip.mp4", nil) {
		t.Fatal("expected http URL to be unsafe")
	}
	if isPublicDirectURLSafe("https://cdn.example/clip.mp4", map[string]string{"Cookie": "secret"}) {
		t.Fatal("expected cookie-bearing URL to be unsafe")
	}

	clean := sanitizePublicHTTPHeaders(map[string]string{
		"Cookie":     "secret",
		"User-Agent": "agent",
		"Referer":    "https://example.com/",
		"X-Ignore":   "nope",
	})
	if len(clean) != 2 || clean["User-Agent"] != "agent" || clean["Referer"] == "" {
		t.Fatalf("unexpected sanitized headers: %#v", clean)
	}
}

func TestToASCII(t *testing.T) {
	if got := toASCII("hello世界"); got != "hello__" {
		t.Errorf("toASCII = %q, want %q", got, "hello__")
	}
	if got := toASCII("normal.mp4"); got != "normal.mp4" {
		t.Errorf("toASCII = %q, want %q", got, "normal.mp4")
	}
}

func TestIsAuthorized(t *testing.T) {
	defer testEnv("LOCAL_ORIGIN_API_KEY", "testkey")()
	apiKey = "testkey"

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Api-Key testkey")
	if !isAuthorized(req) {
		t.Error("expected authorized")
	}

	req2 := httptest.NewRequest("GET", "/", nil)
	req2.Header.Set("Authorization", "Bearer wrong")
	if isAuthorized(req2) {
		t.Error("expected unauthorized")
	}

	req3 := httptest.NewRequest("GET", "/", nil)
	if isAuthorized(req3) {
		t.Error("expected unauthorized with no auth header")
	}
}

func TestEnvInt(t *testing.T) {
	defer testEnv("TEST_PORT", "9010")()
	if got := envInt("TEST_PORT", 8080); got != 9010 {
		t.Errorf("envInt = %d, want %d", got, 9010)
	}

	if got := envInt("NONEXISTENT_VAR", 8080); got != 8080 {
		t.Errorf("envInt default = %d, want %d", got, 8080)
	}
}

func TestEnvAliasesAndBool(t *testing.T) {
	defer testEnv("DOWNLOAD_TTL_SECONDS", "456")()
	if got := envIntAny([]string{"TTL_SECONDS", "DOWNLOAD_TTL_SECONDS"}, 1200); got != 456 {
		t.Errorf("envIntAny alias = %d, want 456", got)
	}

	defer testEnv("SAVE_INFO_JSON", "true")()
	if !envBool("SAVE_INFO_JSON", false) {
		t.Error("envBool should parse true")
	}
}

func TestHealthEndpoint(t *testing.T) {
	defer testEnv("YTDLP_VERSION", "test-version")()
	ytdlpVer = ""
	ytdlpVerOnce = sync.Once{}
	apiKey = "testkey"
	publicURL = "http://127.0.0.1:9010"
	ytdlpPath = "echo" // fake yt-dlp for testing

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" && (r.URL.Path == "/" || r.URL.Path == "") {
			handleHealth(w, r)
			return
		}
		writeJSON(w, 404, map[string]any{"error": "Not found."})
	})

	req := httptest.NewRequest("GET", "/", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Errorf("health status = %d, want 200", w.Code)
	}

	var body map[string]any
	json.NewDecoder(w.Body).Decode(&body)
	if body["ok"] != true {
		t.Error("health ok should be true")
	}
}

func TestUnauthorizedExtract(t *testing.T) {
	apiKey = "testkey"
	publicURL = "http://127.0.0.1:9010"

	req := httptest.NewRequest("POST", "/extract", strings.NewReader(`{"url":"https://tiktok.com/test"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handleExtract(w, req)

	if w.Code != 401 {
		t.Errorf("unauthorized extract status = %d, want 401", w.Code)
	}
}

func TestConcurrentRequests(t *testing.T) {
	os.Setenv("MAX_CONCURRENCY", "2")
	// Reset sema
	sema = make(chan struct{}, 2)
	apiKey = "testkey"
	publicURL = "http://127.0.0.1:9010"

	// Test that we can acquire up to 2 slots
	select {
	case sema <- struct{}{}:
	default:
		t.Error("should be able to acquire slot 1")
	}
	select {
	case sema <- struct{}{}:
	default:
		t.Error("should be able to acquire slot 2")
	}
	select {
	case sema <- struct{}{}:
		t.Error("should not be able to acquire slot 3")
	default:
		// expected
	}

	// Release slots
	<-sema
	<-sema
}

func TestSourceCacheReusesResolvedDownloads(t *testing.T) {
	cacheMu.Lock()
	cache = map[string]*CachedDownload{}
	sourceCache = map[string]*CachedDownload{}
	cacheMu.Unlock()
	maxCacheEntries = 8

	resolved := &CachedDownload{
		CreatedAt:    1,
		DirectURL:    "https://cdn.example/clip.mp4",
		ExpiresAt:    9999999999,
		Filename:     "clip.mp4",
		HTTPHeaders:  map[string]string{"User-Agent": "test-agent"},
		InfoJSONPath: "/tmp/owned-by-download.info.json",
		SourceURL:    "https://www.tiktok.com/@demo/video/1234567890123456789",
		Type:         "video",
	}
	id := storeResolvedDownload(resolved)
	if id == "" {
		t.Fatal("expected download id")
	}

	cached, ok := getCachedSource(resolved.SourceURL)
	if !ok {
		t.Fatal("expected source cache hit")
	}
	if cached.DirectURL != resolved.DirectURL {
		t.Fatalf("cached direct URL = %q, want %q", cached.DirectURL, resolved.DirectURL)
	}
	if cached.InfoJSONPath != "" {
		t.Fatalf("source cache must not share info-json ownership, got %q", cached.InfoJSONPath)
	}
	cached.HTTPHeaders["User-Agent"] = "mutated"
	again, _ := getCachedSource(resolved.SourceURL)
	if again.HTTPHeaders["User-Agent"] != "test-agent" {
		t.Fatal("source cache headers should be cloned")
	}
}

func TestCleanupCacheCapsEntries(t *testing.T) {
	cacheMu.Lock()
	cache = map[string]*CachedDownload{
		"old": {CreatedAt: 1, ExpiresAt: 9999999999},
		"new": {CreatedAt: 2, ExpiresAt: 9999999999},
	}
	sourceCache = map[string]*CachedDownload{
		"old-source": {CreatedAt: 1, ExpiresAt: 9999999999},
		"new-source": {CreatedAt: 2, ExpiresAt: 9999999999},
	}
	cacheMu.Unlock()
	maxCacheEntries = 1

	cleanupCache()

	cacheMu.RLock()
	defer cacheMu.RUnlock()
	if _, ok := cache["old"]; ok {
		t.Error("expected oldest cache entry to be removed")
	}
	if _, ok := cache["new"]; !ok {
		t.Error("expected newest cache entry to remain")
	}
	if _, ok := sourceCache["old-source"]; ok {
		t.Error("expected oldest source cache entry to be removed")
	}
	if _, ok := sourceCache["new-source"]; !ok {
		t.Error("expected newest source cache entry to remain")
	}
}

func TestNewID(t *testing.T) {
	id1 := newID()
	id2 := newID()
	if id1 == "" || id2 == "" || id1 == id2 {
		t.Fatalf("newID should produce non-empty unique ids, got %q and %q", id1, id2)
	}
	if strings.ContainsAny(id1, "/+=") {
		t.Fatalf("newID should be URL-safe, got %q", id1)
	}
}
