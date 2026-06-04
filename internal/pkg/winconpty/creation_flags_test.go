package winconpty

import "testing"

func TestProcessCreationFlagsHideConsoleWindow(t *testing.T) {
	flags := processCreationFlags(false)

	if flags&createNoWindowFlag == 0 {
		t.Fatalf("processCreationFlags() = %#x, want CREATE_NO_WINDOW", flags)
	}
	if flags&extendedStartupInfoPresentFlag == 0 {
		t.Fatalf("processCreationFlags() = %#x, want EXTENDED_STARTUPINFO_PRESENT", flags)
	}
	if flags&createUnicodeEnvironmentFlag != 0 {
		t.Fatalf("processCreationFlags() = %#x, CREATE_UNICODE_ENVIRONMENT should only be set when env is present", flags)
	}
}

func TestProcessCreationFlagsPreserveUnicodeEnvironment(t *testing.T) {
	flags := processCreationFlags(true)

	if flags&createNoWindowFlag == 0 {
		t.Fatalf("processCreationFlags(true) = %#x, want CREATE_NO_WINDOW", flags)
	}
	if flags&createUnicodeEnvironmentFlag == 0 {
		t.Fatalf("processCreationFlags(true) = %#x, want CREATE_UNICODE_ENVIRONMENT", flags)
	}
}
