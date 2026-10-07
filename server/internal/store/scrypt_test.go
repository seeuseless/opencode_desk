package store

import "testing"

func TestHashAndCheck(t *testing.T) {
	h, err := HashPassword("ffcd606f8976037d61")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("hash = %s", h)
	if !CheckPassword("ffcd606f8976037d61", h) {
		t.Error("同一密码应校验通过")
	}
	if CheckPassword("wrong", h) {
		t.Error("错误密码不应通过")
	}
}
