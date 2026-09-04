package auth

import "testing"

func TestHashVerifyRoundTrip(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	ok, err := VerifyPassword("correct horse battery staple", hash)
	if err != nil || !ok {
		t.Fatalf("VerifyPassword(correct) = %v, %v; want true", ok, err)
	}
	ok, err = VerifyPassword("wrong password", hash)
	if err != nil || ok {
		t.Fatalf("VerifyPassword(wrong) = %v, %v; want false", ok, err)
	}
}

func TestHashSalts(t *testing.T) {
	a, _ := HashPassword("same-password")
	b, _ := HashPassword("same-password")
	if a == b {
		t.Fatal("two hashes of the same password must differ (random salt)")
	}
	ok, _ := VerifyPassword("same-password", b)
	if !ok {
		t.Fatal("second hash must still verify")
	}
}

func TestVerifyMalformedHash(t *testing.T) {
	for _, bad := range []string{
		"",
		"not-a-hash",
		"$argon2i$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA",
		"$argon2id$v=19$m=abc,t=3,p=4$c2FsdA$aGFzaA",
		"$argon2id$v=19$m=65536,t=3,p=4$!notb64!$aGFzaA",
		"$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$!notb64!",
	} {
		if _, err := VerifyPassword("x", bad); err == nil {
			t.Errorf("VerifyPassword(%q) should fail", bad)
		}
	}
}
