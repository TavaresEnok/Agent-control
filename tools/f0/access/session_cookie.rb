# frozen_string_literal: true

module F0Access
  # Trusted, in-process laboratory channel. Never installed in the app stack.
  # Cookies must wrap CookieStore: it serializes the signed/encrypted jar into
  # Set-Cookie after the session middleware commits it (Rails 8.1).
  class SessionCookie
    def initialize(application)
      @application = application
    end

    def call(endpoint, cookie: nil)
      store = ActionDispatch::Session::CookieStore.new(endpoint, **@application.config.session_options)
      stack = ActionDispatch::Cookies.new(store)
      env = Rack::MockRequest.env_for("http://web:4000/").merge(@application.env_config)
      env["HTTP_COOKIE"] = cookie if cookie
      stack.call(env)
    end

    def issue(values)
      writer = lambda do |env|
        session = env.fetch("rack.session")
        values.each { |key, value| session[key] = value }
        [ 200, {}, [ "" ] ]
      end
      _, headers, = call(writer)
      header = Array(headers["set-cookie"]).first
      raise "Laboratory session Set-Cookie missing" unless header && !header.empty?

      cookie = header.split(";", 2).first
      recovered = read(cookie, values.keys)
      raise "Laboratory session round-trip failed" unless values.all? { |key, value| recovered[key] == value }

      cookie
    end

    def read(cookie, keys)
      recovered = nil
      reader = lambda do |env|
        session = env.fetch("rack.session")
        recovered = keys.to_h { |key| [ key, session[key] ] }
        [ 200, {}, [ "" ] ]
      end
      call(reader, cookie: cookie)
      recovered
    end
  end
end
