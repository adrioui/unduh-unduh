// Package main implements a lightweight yt-dlp bridge HTTP server.
//
// It replaces the Node.js local-origin-server.ts with a compiled Go binary
// that uses ~5-10MB RAM at idle instead of ~100MB.
//
// Endpoints:
//   - GET  /           → health check (version, supported platforms)
//   - POST /extract    → resolve a TikTok/Instagram URL via yt-dlp
//   - GET  /download?id=<uuid> → stream the cached download
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ── Configuration (loaded in main) ──

var (
	port              int
	publicURL         string
	apiKey            string
	ytdlpProxy        string
	ytdlpCookies      string
	ytdlpImpersonate  string
	ttlSeconds        int
	concurrency       int
	maxCacheEntries   int
	busyWait          time.Duration
	ytdlpTimeout      time.Duration
	maxYtdlpJSONBytes int64
	saveInfoJSON      bool
	ytdlpPath         string
)

func loadConfig() {
	port = envInt("LOCAL_ORIGIN_PORT", 9010)
	publicURL = envReq("LOCAL_ORIGIN_PUBLIC_URL")
	apiKey = envReq("LOCAL_ORIGIN_API_KEY")
	ytdlpProxy = os.Getenv("YTDLP_PROXY")
	ytdlpCookies = os.Getenv("YTDLP_COOKIES_FILE")
	ytdlpImpersonate = os.Getenv("YTDLP_IMPERSONATE")
	ttlSeconds = envIntAny([]string{"TTL_SECONDS", "DOWNLOAD_TTL_SECONDS"}, 1200)
	concurrency = max(1, envIntAny([]string{"MAX_CONCURRENCY", "MAX_JOBS"}, 1))
	maxCacheEntries = max(1, envInt("MAX_CACHE_ENTRIES", 64))
	busyWait = time.Duration(max(0, envInt("BUSY_WAIT_SECONDS", 15))) * time.Second
	ytdlpTimeout = time.Duration(max(10, envIntAny([]string{"YTDLP_TIMEOUT_SECONDS", "YTDLP_TIMEOUT"}, 90))) * time.Second
	maxYtdlpJSONBytes = int64(max(256*1024, envInt("MAX_YTDLP_JSON_BYTES", 4*1024*1024)))
	saveInfoJSON = envBool("SAVE_INFO_JSON", false)
	ytdlpPath = findYtdlp()
	tuneRuntime()
}

// ── Types ──

type CachedDownload struct {
	Caption      string            `json:"caption,omitempty"`
	CreatedAt    int64             `json:"createdAt"`
	DirectURL    string            `json:"directUrl"`
	ExpiresAt    int64             `json:"expiresAt"`
	Filename     string            `json:"filename"`
	InfoJSONPath string            `json:"infoJsonPath,omitempty"`
	SourceURL    string            `json:"sourceUrl"`
	ThumbnailURL string            `json:"thumbnailUrl,omitempty"`
	Type         string            `json:"type,omitempty"`
	HTTPHeaders  map[string]string `json:"httpHeaders,omitempty"`
}

type ExtractResponse struct {
	Caption      string            `json:"caption,omitempty"`
	DirectURL    string            `json:"directUrl,omitempty"`
	Filename     string            `json:"filename"`
	HTTPHeaders  map[string]string `json:"httpHeaders,omitempty"`
	ThumbnailURL string            `json:"thumbnailUrl,omitempty"`
	Type         string            `json:"type,omitempty"`
	URL          string            `json:"url"`
}

type ytDlpResult struct {
	Description        string            `json:"description"`
	Ext                string            `json:"ext"`
	HTTPHeaders        map[string]string `json:"http_headers"`
	ID                 string            `json:"id"`
	Thumbnail          string            `json:"thumbnail"`
	RequestedDownloads []struct {
		Ext         string            `json:"ext"`
		Filename    string            `json:"filename"`
		HTTPHeaders map[string]string `json:"http_headers"`
		URL         string            `json:"url"`
	} `json:"requested_downloads"`
}

// ── Global state ──

var (
	cache           = make(map[string]*CachedDownload)
	sourceCache     = make(map[string]*CachedDownload)
	cacheMu         sync.RWMutex
	inflightSources = make(map[string]*inflightExtraction)
	inflightMu      sync.Mutex
	sema            chan struct{}
	ytdlpVer        string
	ytdlpVerOnce    sync.Once
)

var errExtractorBusy = errors.New("extractor is busy")

type inflightExtraction struct {
	done   chan struct{}
	err    error
	result *CachedDownload
}

// ── HTTP handlers ──

func handleHealth(w http.ResponseWriter, r *http.Request) {
	version := getYtdlpVersion()
	writeJSON(w, 200, map[string]any{
		"ok":                 true,
		"supportedPlatforms": []string{"instagram", "tiktok"},
		"version":            version,
	})
}

func handleExtract(w http.ResponseWriter, r *http.Request) {
	if !isAuthorized(r) {
		writeJSON(w, 401, map[string]any{"error": "Unauthorized"})
		return
	}

	var body struct {
		URL string `json:"url"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16*1024)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.URL == "" {
		writeJSON(w, 400, map[string]any{"error": "Provide a valid URL."})
		return
	}

	resolved, err := resolveSourceCached(r.Context(), body.URL)
	if err != nil {
		if errors.Is(err, errExtractorBusy) {
			writeJSON(w, 503, map[string]any{"error": "Extractor is busy. Try again."})
			return
		}
		writeJSON(w, 422, map[string]any{"error": err.Error()})
		return
	}

	id := storeResolvedDownload(resolved)

	resp := ExtractResponse{
		Filename: resolved.Filename,
		URL:      strings.TrimRight(publicURL, "/") + "/download?id=" + id,
	}
	if resolved.Caption != "" {
		resp.Caption = resolved.Caption
	}
	if resolved.DirectURL != "" && isPublicDirectURLSafe(resolved.DirectURL, resolved.HTTPHeaders) {
		resp.DirectURL = resolved.DirectURL
		if headers := sanitizePublicHTTPHeaders(resolved.HTTPHeaders); len(headers) > 0 {
			resp.HTTPHeaders = headers
		}
	}
	if resolved.ThumbnailURL != "" {
		resp.ThumbnailURL = resolved.ThumbnailURL
	}
	if resolved.Type != "" {
		resp.Type = resolved.Type
	}

	writeJSON(w, 200, resp)
}

func handleDownload(w http.ResponseWriter, r *http.Request) {
	if !isAuthorized(r) {
		writeJSON(w, 401, map[string]any{"error": "Unauthorized"})
		return
	}

	id := r.URL.Query().Get("id")
	if id == "" {
		writeJSON(w, 400, map[string]any{"error": "Missing download id."})
		return
	}

	cacheMu.Lock()
	cached, ok := cache[id]
	if !ok || cached.ExpiresAt < time.Now().Unix() {
		deleteCachedLocked(id, cached)
		cacheMu.Unlock()
		writeJSON(w, 410, map[string]any{"error": "Download id expired."})
		return
	}
	cacheMu.Unlock()

	// Try direct download first, fallback to yt-dlp streaming.
	if cached.DirectURL != "" {
		if err := streamDirect(w, r, cached); err != nil {
			log.Printf("[extractor] direct stream failed: %v, trying yt-dlp", err)
			streamWithYtDlp(w, r, cached)
		}
		return
	}
	streamWithYtDlp(w, r, cached)
}

func streamDirect(w http.ResponseWriter, r *http.Request, cached *CachedDownload) error {
	ctx, cancel := context.WithTimeout(r.Context(), 180*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", cached.DirectURL, nil)
	if err != nil {
		return err
	}
	setDirectRequestHeaders(req.Header, cached.HTTPHeaders)

	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("upstream returned %d", resp.StatusCode)
	}

	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Type", inferContentType(cached.Filename))
	h.Set("Content-Disposition", buildContentDisposition(cached.Filename))
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		h.Set("Content-Length", cl)
	}
	w.WriteHeader(200)

	buf := bufPool.Get().([]byte)
	defer bufPool.Put(buf)
	_, err = io.CopyBuffer(w, resp.Body, buf)
	return err
}

func streamWithYtDlp(w http.ResponseWriter, r *http.Request, cached *CachedDownload) {
	if !acquireSlot(r.Context()) {
		writeJSON(w, 503, map[string]any{"error": "Extractor is busy. Try again."})
		return
	}
	defer releaseSlot()

	args := buildYtDlpBaseArgs()
	args = append(args, "--no-progress", "--retries", "3", "--fragment-retries", "3", "-o", "-")

	if cached.InfoJSONPath != "" {
		if _, err := os.Stat(cached.InfoJSONPath); err == nil {
			args = append(args, "--load-info-json", cached.InfoJSONPath)
		} else {
			args = append(args, cached.SourceURL)
		}
	} else {
		args = append(args, cached.SourceURL)
	}

	ctx, cancel := context.WithTimeout(r.Context(), 300*time.Second)
	defer cancel()

	cmd := newYtDlpCommand(ctx, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		writeJSON(w, 502, map[string]any{"error": err.Error()})
		return
	}
	cmd.Stderr = nil // discard stderr

	if err := cmd.Start(); err != nil {
		writeJSON(w, 502, map[string]any{"error": err.Error()})
		return
	}

	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Disposition", buildContentDisposition(cached.Filename))
	h.Set("Content-Type", inferContentType(cached.Filename))
	w.WriteHeader(200)

	buf := bufPool.Get().([]byte)
	defer bufPool.Put(buf)
	_, _ = io.CopyBuffer(w, stdout, buf)

	_ = cmd.Wait()

	// Cleanup info JSON
	if cached.InfoJSONPath != "" {
		os.Remove(cached.InfoJSONPath)
	}
}

// ── yt-dlp helpers ──

func buildYtDlpBaseArgs() []string {
	args := []string{"--ignore-config", "--no-playlist", "--no-warnings", "--no-write-comments", "--no-cache-dir", "--socket-timeout", strconv.Itoa(max(10, int(ytdlpTimeout.Seconds())))}
	if ytdlpProxy != "" {
		args = append(args, "--proxy", ytdlpProxy)
	}
	if ytdlpCookies != "" {
		if _, err := os.Stat(ytdlpCookies); err == nil {
			args = append(args, "--cookies", ytdlpCookies)
		}
	}
	if ytdlpImpersonate != "" {
		args = append(args, "--impersonate", ytdlpImpersonate)
	}
	return args
}

func resolveSourceCached(ctx context.Context, sourceURL string) (*CachedDownload, error) {
	if cached, ok := getCachedSource(sourceURL); ok {
		return cached, nil
	}

	call, owner := beginInflightExtraction(sourceURL)
	if !owner {
		select {
		case <-call.done:
			if call.err != nil {
				return nil, call.err
			}
			return cloneCachedDownload(call.result), nil
		case <-ctx.Done():
			return nil, errExtractorBusy
		}
	}

	resolved, err := resolveSourceExclusive(ctx, sourceURL)
	finishInflightExtraction(sourceURL, call, resolved, err)
	if err != nil {
		return nil, err
	}
	return resolved, nil
}

func resolveSourceExclusive(ctx context.Context, sourceURL string) (*CachedDownload, error) {
	if !acquireSlot(ctx) {
		return nil, errExtractorBusy
	}
	defer releaseSlot()

	// A concurrent request may have populated the source cache while this
	// request waited for the tiny-VPS extraction slot.
	if cached, ok := getCachedSource(sourceURL); ok {
		return cached, nil
	}

	resolved, err := resolveSource(sourceURL)
	if err != nil {
		return nil, err
	}
	storeSourceCache(resolved)
	return resolved, nil
}

func beginInflightExtraction(sourceURL string) (*inflightExtraction, bool) {
	inflightMu.Lock()
	defer inflightMu.Unlock()

	if call, ok := inflightSources[sourceURL]; ok {
		return call, false
	}
	call := &inflightExtraction{done: make(chan struct{})}
	inflightSources[sourceURL] = call
	return call, true
}

func finishInflightExtraction(sourceURL string, call *inflightExtraction, resolved *CachedDownload, err error) {
	inflightMu.Lock()
	if inflightSources[sourceURL] == call {
		delete(inflightSources, sourceURL)
	}
	call.result = cloneCachedDownload(resolved)
	call.err = err
	close(call.done)
	inflightMu.Unlock()
}

func resolveSource(sourceURL string) (*CachedDownload, error) {
	args := append(buildYtDlpBaseArgs(), "--skip-download", "--dump-single-json", sourceURL)
	ctx, cancel := context.WithTimeout(context.Background(), ytdlpTimeout)
	defer cancel()

	out, err := runYtDlpOutputLimited(ctx, args, maxYtdlpJSONBytes)
	if err != nil {
		return nil, fmt.Errorf("yt-dlp extraction failed: %s", trimErr("", err))
	}

	var parsed ytDlpResult
	if err := json.Unmarshal(out, &parsed); err != nil {
		return nil, fmt.Errorf("failed to parse yt-dlp output")
	}

	if len(parsed.RequestedDownloads) == 0 || parsed.RequestedDownloads[0].URL == "" {
		return nil, fmt.Errorf("unsupported URL or extraction failed")
	}

	rd := parsed.RequestedDownloads[0]
	mediaType := inferMediaType(rd.Ext)
	if mediaType == "" {
		mediaType = inferMediaType(parsed.Ext)
	}
	if mediaType == "" {
		mediaType = "video"
	}

	ext := strings.Trim(strings.ToLower(rd.Ext), ". ")
	filename := sanitizeDownloadFilename(rd.Filename)
	if filename == "" {
		base := strings.TrimSpace(parsed.ID)
		if base == "" {
			base = "download"
		}
		if ext != "" {
			filename = sanitizeDownloadFilename(base + "." + ext)
		} else {
			filename = sanitizeDownloadFilename(base)
		}
	}
	if filename == "" {
		filename = "download"
	}

	infoJSONPath := ""
	if saveInfoJSON {
		infoJSONPath = filepath.Join(os.TempDir(), fmt.Sprintf("uu-%s.info.json", newID()))
		if err := os.WriteFile(infoJSONPath, out, 0600); err != nil {
			infoJSONPath = "" // best effort
		}
	}

	headers := parsed.HTTPHeaders
	if len(rd.HTTPHeaders) > 0 {
		headers = rd.HTTPHeaders
	}

	now := time.Now()
	result := &CachedDownload{
		CreatedAt:    now.Unix(),
		DirectURL:    rd.URL,
		ExpiresAt:    now.Add(time.Duration(ttlSeconds) * time.Second).Unix(),
		Filename:     filename,
		InfoJSONPath: infoJSONPath,
		SourceURL:    sourceURL,
		Type:         mediaType,
		HTTPHeaders:  headers,
	}
	if strings.TrimSpace(parsed.Description) != "" {
		result.Caption = strings.TrimSpace(parsed.Description)
	}
	if parsed.Thumbnail != "" {
		result.ThumbnailURL = parsed.Thumbnail
	}

	return result, nil
}

func getYtdlpVersion() string {
	ytdlpVerOnce.Do(func() {
		if version := strings.TrimSpace(os.Getenv("YTDLP_VERSION")); version != "" {
			ytdlpVer = version
			return
		}

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		out, err := newYtDlpCommand(ctx, "--version").Output()
		if err == nil {
			ytdlpVer = strings.TrimSpace(string(out))
		} else {
			ytdlpVer = "unknown"
		}
	})
	return ytdlpVer
}

func newYtDlpCommand(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, ytdlpPath, args...)
	cmd.Env = append(os.Environ(),
		"HOME=/tmp",
		"XDG_CACHE_HOME=/tmp",
		"PYTHONUNBUFFERED=1",
	)
	configureCommandCancellation(cmd)
	return cmd
}

func runYtDlpOutputLimited(ctx context.Context, args []string, maxBytes int64) ([]byte, error) {
	cmd := newYtDlpCommand(ctx, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	var stderrBuf limitedBuffer
	stderrBuf.limit = 32 * 1024
	stderrDone := make(chan error, 1)
	go func() {
		_, err := io.Copy(&stderrBuf, stderr)
		stderrDone <- err
	}()

	out, readErr := io.ReadAll(io.LimitReader(stdout, maxBytes+1))
	if int64(len(out)) > maxBytes {
		cancelCommand(cmd)
		_ = cmd.Wait()
		<-stderrDone
		return nil, fmt.Errorf("yt-dlp JSON output exceeded %d bytes", maxBytes)
	}

	waitErr := cmd.Wait()
	stderrErr := <-stderrDone
	if readErr != nil {
		return nil, readErr
	}
	if waitErr != nil {
		if msg := strings.TrimSpace(stderrBuf.String()); msg != "" {
			return out, fmt.Errorf("%w: %s", waitErr, msg)
		}
		return out, waitErr
	}
	if stderrErr != nil {
		return out, stderrErr
	}
	return out, nil
}

func cancelCommand(cmd *exec.Cmd) {
	if cmd.Cancel != nil {
		_ = cmd.Cancel()
		return
	}
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

type limitedBuffer struct {
	bytes.Buffer
	limit     int64
	truncated bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	originalLen := len(p)
	remaining := int(b.limit) - b.Buffer.Len()
	if remaining <= 0 {
		b.truncated = b.truncated || originalLen > 0
		return originalLen, nil
	}
	if len(p) > remaining {
		_, _ = b.Buffer.Write(p[:remaining])
		b.truncated = true
		return originalLen, nil
	}
	_, _ = b.Buffer.Write(p)
	return originalLen, nil
}

func (b *limitedBuffer) String() string {
	if !b.truncated {
		return b.Buffer.String()
	}
	return b.Buffer.String() + "..."
}

// ── Streaming buffer pool ──

var httpClient = &http.Client{
	Timeout: 180 * time.Second,
	Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		DisableCompression:    true,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          32,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	},
}

var bufPool = sync.Pool{
	New: func() any {
		buf := make([]byte, 64*1024)
		return buf
	},
}

// ── Utility functions ──

const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

func setDirectRequestHeaders(headers http.Header, upstreamHeaders map[string]string) {
	for k, v := range upstreamHeaders {
		if shouldSkipDirectRequestHeader(k, v) {
			continue
		}
		headers.Set(k, v)
	}
	if headers.Get("User-Agent") == "" {
		headers.Set("User-Agent", userAgent)
	}
	// Keep media streams byte-for-byte and avoid transparent gzip decode CPU/RAM.
	headers.Set("Accept-Encoding", "identity")
}

func shouldSkipDirectRequestHeader(name, value string) bool {
	if strings.ContainsAny(value, "\r\n") || len(value) > 2048 {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "accept-encoding", "connection", "content-length", "host", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade":
		return true
	}
	return false
}

func isAuthorized(r *http.Request) bool {
	auth := r.Header.Get("Authorization")
	expected := "Api-Key " + apiKey
	return len(auth) == len(expected) && subtle.ConstantTimeCompare([]byte(auth), []byte(expected)) == 1
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

func buildContentDisposition(filename string) string {
	filename = sanitizeDownloadFilename(filename)
	if filename == "" {
		filename = "download"
	}
	ascii := toASCII(filename)
	return fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, ascii, pathEscape(filename))
}

func sanitizeDownloadFilename(filename string) string {
	filename = strings.TrimSpace(strings.ReplaceAll(filename, "\\", "/"))
	if filename == "" {
		return ""
	}
	filename = filepath.Base(filename)
	if filename == "." || filename == "/" {
		return ""
	}

	var b strings.Builder
	for _, r := range filename {
		if r < 0x20 || r == 0x7F || r == '/' || r == '\\' || r == '"' {
			b.WriteByte('_')
			continue
		}
		b.WriteRune(r)
		if b.Len() >= 180 {
			break
		}
	}
	return strings.Trim(strings.TrimSpace(b.String()), ".")
}

func pathEscape(s string) string {
	return strings.ReplaceAll(
		strings.ReplaceAll(
			strings.ReplaceAll(urlPathEscape(s), "!", "%21"),
			"'", "%27"),
		"(", "%28",
	)
}

func urlPathEscape(s string) string {
	// Simple percent-encoding for filename*
	var b strings.Builder
	for _, r := range s {
		if r <= 0x7E && r != '%' && r != '/' {
			b.WriteRune(r)
		} else {
			fmt.Fprintf(&b, "%%%02X", r)
		}
	}
	return b.String()
}

func toASCII(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= 0x20 && r <= 0x7E {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	return b.String()
}

func inferMediaType(ext string) string {
	switch strings.ToLower(ext) {
	case "mp4", "webm", "mkv", "avi", "mov", "flv":
		return "video"
	case "mp3", "m4a", "ogg", "wav", "flac", "aac", "opus":
		return "audio"
	case "jpg", "jpeg", "png", "webp", "gif":
		return "photo"
	}
	return ""
}

func isPublicDirectURLSafe(rawURL string, headers map[string]string) bool {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" {
		return false
	}
	for name := range headers {
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "authorization", "cookie", "proxy-authorization":
			return false
		}
	}
	return true
}

func sanitizePublicHTTPHeaders(headers map[string]string) map[string]string {
	allowed := map[string]string{
		"accept":          "Accept",
		"accept-language": "Accept-Language",
		"referer":         "Referer",
		"user-agent":      "User-Agent",
	}
	clean := make(map[string]string, len(headers))
	for name, value := range headers {
		canonical, ok := allowed[strings.ToLower(strings.TrimSpace(name))]
		if !ok || strings.ContainsAny(value, "\r\n") || len(value) > 512 {
			continue
		}
		clean[canonical] = value
	}
	return clean
}

func inferContentType(filename string) string {
	lower := strings.ToLower(filename)
	switch {
	case strings.HasSuffix(lower, ".mp4"):
		return "video/mp4"
	case strings.HasSuffix(lower, ".webm"):
		return "video/webm"
	case strings.HasSuffix(lower, ".mp3"):
		return "audio/mpeg"
	case strings.HasSuffix(lower, ".m4a"):
		return "audio/mp4"
	case strings.HasSuffix(lower, ".jpg") || strings.HasSuffix(lower, ".jpeg"):
		return "image/jpeg"
	case strings.HasSuffix(lower, ".png"):
		return "image/png"
	case strings.HasSuffix(lower, ".webp"):
		return "image/webp"
	}
	return "application/octet-stream"
}

func getCachedSource(sourceURL string) (*CachedDownload, bool) {
	now := time.Now().Unix()
	cacheMu.Lock()
	defer cacheMu.Unlock()

	cached, ok := sourceCache[sourceURL]
	if !ok {
		return nil, false
	}
	if cached.ExpiresAt < now {
		deleteSourceCachedLocked(sourceURL, cached)
		return nil, false
	}

	return cloneCachedDownload(cached), true
}

func storeSourceCache(resolved *CachedDownload) {
	if resolved == nil || resolved.SourceURL == "" {
		return
	}

	cacheMu.Lock()
	sourceCache[resolved.SourceURL] = cloneCachedDownload(resolved)
	cacheMu.Unlock()
}

func storeResolvedDownload(resolved *CachedDownload) string {
	id := newID()
	cleanupCache()

	cacheMu.Lock()
	cache[id] = resolved
	sourceCache[resolved.SourceURL] = cloneCachedDownload(resolved)
	cacheMu.Unlock()

	cleanupCache()
	return id
}

func cloneCachedDownload(cached *CachedDownload) *CachedDownload {
	if cached == nil {
		return nil
	}
	clone := *cached
	// Source-cache entries should not share temporary info-json ownership with
	// per-download entries. Direct URLs remain reusable; yt-dlp fallback can
	// re-resolve from SourceURL if a cached direct URL stops working.
	clone.InfoJSONPath = ""
	if len(cached.HTTPHeaders) > 0 {
		clone.HTTPHeaders = make(map[string]string, len(cached.HTTPHeaders))
		for k, v := range cached.HTTPHeaders {
			clone.HTTPHeaders[k] = v
		}
	}
	return &clone
}

func cleanupCache() {
	now := time.Now().Unix()
	cacheMu.Lock()
	defer cacheMu.Unlock()
	for k, v := range cache {
		if v.ExpiresAt < now {
			deleteCachedLocked(k, v)
		}
	}
	for k, v := range sourceCache {
		if v.ExpiresAt < now {
			deleteSourceCachedLocked(k, v)
		}
	}

	for len(cache) > maxCacheEntries {
		oldestKey := ""
		oldestCreatedAt := int64(1<<63 - 1)
		for k, v := range cache {
			if v.CreatedAt < oldestCreatedAt {
				oldestKey = k
				oldestCreatedAt = v.CreatedAt
			}
		}
		if oldestKey == "" {
			break
		}
		deleteCachedLocked(oldestKey, cache[oldestKey])
	}
	for len(sourceCache) > maxCacheEntries {
		oldestKey := ""
		oldestCreatedAt := int64(1<<63 - 1)
		for k, v := range sourceCache {
			if v.CreatedAt < oldestCreatedAt {
				oldestKey = k
				oldestCreatedAt = v.CreatedAt
			}
		}
		if oldestKey == "" {
			break
		}
		deleteSourceCachedLocked(oldestKey, sourceCache[oldestKey])
	}
}

func deleteCachedLocked(key string, cached *CachedDownload) {
	if cached != nil && cached.InfoJSONPath != "" {
		_ = os.Remove(cached.InfoJSONPath)
	}
	delete(cache, key)
}

func deleteSourceCachedLocked(key string, cached *CachedDownload) {
	if cached != nil && cached.InfoJSONPath != "" {
		_ = os.Remove(cached.InfoJSONPath)
	}
	delete(sourceCache, key)
}

func acquireSlot(ctx context.Context) bool {
	if busyWait <= 0 {
		select {
		case sema <- struct{}{}:
			return true
		default:
			return false
		}
	}

	ctx, cancel := context.WithTimeout(ctx, busyWait)
	defer cancel()
	select {
	case sema <- struct{}{}:
		return true
	case <-ctx.Done():
		return false
	}
}

func releaseSlot() {
	<-sema
}

func newID() string {
	var b [18]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return base64.RawURLEncoding.EncodeToString(b[:])
}

func tuneRuntime() {
	if memoryMB := envInt("GO_MEMORY_LIMIT_MB", 96); memoryMB > 0 {
		debug.SetMemoryLimit(int64(memoryMB) * 1024 * 1024)
	}
	if gcPercent := envInt("GO_GC_PERCENT", 100); gcPercent > 0 {
		debug.SetGCPercent(gcPercent)
	}
}

func findYtdlp() string {
	if configured := strings.TrimSpace(os.Getenv("YTDLP_PATH")); configured != "" {
		return configured
	}
	for _, candidate := range []string{"yt-dlp", "/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp"} {
		if p, err := exec.LookPath(candidate); err == nil {
			return p
		}
	}
	return "yt-dlp"
}

func trimErr(output string, err error) string {
	s := strings.TrimSpace(output)
	if s == "" {
		s = err.Error()
	}
	if len(s) > 500 {
		return s[:500]
	}
	return s
}

// ── Environment helpers ──

func envInt(key string, def int) int {
	return envIntAny([]string{key}, def)
}

func envIntAny(keys []string, def int) int {
	for _, key := range keys {
		v := strings.TrimSpace(os.Getenv(key))
		if v == "" {
			continue
		}
		n, err := strconv.Atoi(v)
		if err != nil {
			return def
		}
		return n
	}
	return def
}

func envBool(key string, def bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if v == "" {
		return def
	}
	return v == "1" || v == "true" || v == "yes" || v == "on"
}

func envReq(key string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		log.Fatalf("Missing required environment variable: %s", key)
	}
	return v
}

// ── Main ──

func main() {
	loadConfig()
	sema = make(chan struct{}, concurrency)

	// Periodic cache cleanup
	go func() {
		for {
			time.Sleep(60 * time.Second)
			cleanupCache()
		}
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" && (r.URL.Path == "/" || r.URL.Path == "") {
			handleHealth(w, r)
			return
		}
		if r.Method == "POST" && r.URL.Path == "/extract" {
			handleExtract(w, r)
			return
		}
		if r.Method == "GET" && r.URL.Path == "/download" {
			handleDownload(w, r)
			return
		}
		writeJSON(w, 404, map[string]any{"error": "Not found."})
	})

	addr := fmt.Sprintf("127.0.0.1:%d", port)
	log.Printf("[unduh-extractor] listening on http://%s max_concurrency=%d", addr, concurrency)

	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      0, // downloads may be slow; stream without a hard server deadline.
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    8 * 1024,
	}

	if err := server.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}
