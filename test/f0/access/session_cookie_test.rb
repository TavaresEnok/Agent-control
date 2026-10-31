# frozen_string_literal: true

# Build-time check: boot the imported application without test_helper, SQL,
# fixtures, controllers substituted for fakes, or a laboratory login route.
# All session fields here are synthetic scalars; SQL-backed identities are
# prepared and checked by the runtime runner, after its database preflight.
require "securerandom"
require "base64"
raise "Requires isolated test build" unless ENV["RAILS_ENV"] == "test"
raise "Dotenv files refused" unless Dir.glob("{.env*,config/settings.local*,config/settings/*.local*}", File::FNM_EXTGLOB).empty?
ENV["RAILS_SECRET_KEY_BASE"] = SecureRandom.hex(64)
# No build-time SQL target: accidental boot-time queries must fail closed,
# including when the manager builds with host networking for gem downloads.
ENV["DB_HOST"] = "/tmp/f0-access-build-no-database"
ENV["DB_USERNAME"] = "f0_access_lab"
ENV["DB_PASSWORD"] = ""

require_relative "../../../config/application"
Rails.application.config.before_initialize do
  Rails.application.config.action_controller.allow_forgery_protection = true
end
Rails.application.initialize!

require "minitest/autorun"
require_relative "../../../tools/f0/access/session_cookie"

class SessionCookieTest < Minitest::Test
  def setup
    @codec = F0Access::SessionCookie.new(Rails.application)
    @values = { user_id: 41001, user_session_id: 42001, current_company_id: 43001,
                _csrf_token: Base64.strict_encode64(SecureRandom.random_bytes(32)) }
  end

  def test_set_cookie_and_round_trip_through_real_application_verifier
    assert Rails.application.config.action_controller.allow_forgery_protection
    assert ActionController::Base.allow_forgery_protection
    cookie = @codec.issue(@values) # Raises unless actual Set-Cookie is present.
    key = Rails.application.config.session_options.fetch(:key)
    assert cookie.start_with?("#{key}=")
    # Do not print cookie/CSRF even on failed assertion.
    recovered = @codec.read(cookie, @values.keys)
    @values.each { |field, value| assert recovered[field] == value, "Session field did not round-trip: #{field}" }
  end

  def test_tampered_and_missing_cookie_cannot_recover_identity_or_csrf
    cookie = @codec.issue(@values)
    key, value = cookie.split("=", 2)
    tampered = key + "=" + (value.start_with?("A") ? "B" : "A") + value[1..]
    [nil, tampered].each do |candidate|
      recovered = @codec.read(candidate, @values.keys)
      assert recovered.values.all?(&:nil?), "Untrusted cookie recovered laboratory session fields"
    end
  end
end
