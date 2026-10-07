package store

import (
	"crypto/sha256"
	"encoding/hex"
)

// HashToken 令牌明文的 SHA-256。
//
// 为什么不明文存：库里只该有「能验证、不能伪造」的东西。
// 明文只在下发那一刻出现，之后任何接口都拿不回来。
func HashToken(plain string) string {
	sum := sha256.Sum256([]byte(plain))
	return hex.EncodeToString(sum[:])
}

// HashPassword 密码哈希（scrypt，纯 Go 实现，无 CGO 依赖）。
//
// 格式：scrypt$N$r$p$salt$hash，校验时按 $ 拆开逐段比对。
// 桌面端本地一体化模式下密码强度要求不高，但后台要能联网部署，
// 所以不用明文也不用裸 MD5。
func HashPassword(pw string) (string, error) {
	return hashScrypt(pw)
}

// CheckPassword 校验密码。
func CheckPassword(pw, stored string) bool {
	return checkScrypt(pw, stored)
}
