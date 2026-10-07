package api

import (
	"bytes"
	"encoding/json"
	"time"

	"github.com/seeuseless/opencode_desk/server/internal/store"
)

// marshalJSON 紧凑序列化（中文不转义，与 PHP 的 JSON_UNESCAPED_UNICODE 一致）。
func marshalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	// Encode 会补一个换行，去掉
	b := buf.Bytes()
	if n := len(b); n > 0 && b[n-1] == '\n' {
		b = b[:n-1]
	}
	return b, nil
}

// decodeParams 把存库的 params JSON 还原成对象；空或非法给空对象。
func decodeParams(s string) map[string]any {
	if s == "" {
		return map[string]any{}
	}
	var m map[string]any
	if json.Unmarshal([]byte(s), &m) != nil || m == nil {
		return map[string]any{}
	}
	return m
}

// decodePayload 把存库的 payload JSON 还原成对象。
func decodePayload(s string) any {
	if s == "" {
		return map[string]any{}
	}
	var v any
	if json.Unmarshal([]byte(s), &v) != nil || v == nil {
		return map[string]any{}
	}
	return v
}

// fmtTime 契约里的 Y-m-d H:i:s；零值给 null。
func fmtTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return store.FormatTime(t)
}
