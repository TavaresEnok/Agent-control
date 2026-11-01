# frozen_string_literal: true

require "test_helper"

class TerminalOriginAuthTest < ActiveSupport::TestCase
  test "origin credentials are scoped to session and surface" do
    user = create(:user)
    first = create(:terminal_session, user: user)
    second = create(:terminal_session, user: user)
    writable = TerminalOriginAuth.credentials(first, "tty")
    assert_not_equal writable, TerminalOriginAuth.credentials(first, "view")
    assert_not_equal writable, TerminalOriginAuth.credentials(second, "tty")
    assert_equal writable, TerminalOriginAuth.credentials(first, "tty")
  end

  test "missing settings fail closed" do
    Settings.terminal_origin_auth.stubs(:origin_key).returns("")
    assert_raises(TerminalOriginAuth::ConfigurationError) { TerminalOriginAuth.configured! }
    assert_raises(TerminalOriginAuth::ConfigurationError) { TerminalOriginAuth.proxy_authorized?("anything") }
  end

  test "only the configured proxy proof is accepted" do
    assert TerminalOriginAuth.proxy_authorized?(Settings.terminal_origin_auth.proxy_proof)
    assert_not TerminalOriginAuth.proxy_authorized?("forged")
    assert_not TerminalOriginAuth.proxy_authorized?(nil)
  end
end
