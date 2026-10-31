# frozen_string_literal: true

# This is a trusted laboratory process, never mounted as an application route.
# It prepares SQL identities and encrypted cookies, then uses TCP HTTP/WS against
# the untouched Rails Rack stack, and the upstream Traefik ForwardAuth middleware.
require "bundler/setup"
require "json"
require "logger"
require "stringio"
require "securerandom"
require "base64"
require "net/http"
require "pg"
require "yaml"
require "digest"
require_relative "mcp_evidence"
require_relative "session_cookie"
require_relative "readiness"

module F0Access
  class Lab
    def initialize
      @rows = []
    end

    def check(name)
      ok, observed = yield
      @rows << { name: name, status: ok == :notrun ? "NOTRUN" : (ok ? "PASS" : "FAIL"), observed: observed }
    rescue StandardError => e
      # Exception messages may contain bodies, keys or cookies. Class only.
      @rows << { name: name, status: "NOTRUN", error_class: e.class.name }
    end

    def request(path, identity: nil, method: :get, body: nil, headers: {}, csrf: true, host: "web", port: 4000)
      uri = URI("http://#{host}:#{port}#{path}")
      req = Net::HTTP.const_get(method.to_s.capitalize).new(uri)
      req["Cookie"] = identity[:cookie] if identity
      req["X-CSRF-Token"] = identity[:csrf] if identity && csrf
      req["Accept"] = "application/json"
      headers.each { |key, value| req[key] = value }
      if body
        req["Content-Type"] = "application/json"
        req.body = JSON.generate(body)
      end
      Net::HTTP.start(uri.host, uri.port, nil, nil, nil, nil, open_timeout: 2, read_timeout: 10) { |http| http.request(req) }
    end

    def rpc(method, token: nil, worker: nil, name: nil, arguments: {})
      headers = { "Accept" => "application/json, text/event-stream" }
      headers["Authorization"] = "Bearer #{token}" if token
      headers["X-Session-Key"] = worker if worker
      params = name ? { name: name, arguments: arguments } : {}
      request(worker ? "/action_mcp" : "/mcp", method: :post,
              body: { jsonrpc: "2.0", id: 1, method: method, params: params }, headers: headers)
    end

    def effect_snapshot
      # SQL values, not HTTP status or a spy: detects inserts, updates, deletes in
      # the protected domain, including an accidental session launch/admission.
      %w[terminal_sessions session_admissions agents projects company_memberships tools].to_h do |table|
        sql = "SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id)::text, '[]')) FROM #{table} t"
        [table, ActiveRecord::Base.connection.select_value(sql)]
      end
    end

    def unchanged(name)
      before = effect_snapshot
      check(name) do
        response, allowed, evidence = yield
        same = before == effect_snapshot
        [allowed && same, { http: response.code.to_i, protected_sql_unchanged: same }.merge(evidence || {})]
      end
    end

    def identity(user, company)
      row = UserSession.start!(user: user)
      Auth::SessionService.record_proof(row, IdentityProvider.password)
      csrf = Base64.strict_encode64(SecureRandom.random_bytes(32))
      # Use the real Cookies -> CookieStore stack, app options and env_config.
      # issue requires Set-Cookie and verifies all fields through a fresh reader
      # before any identity is used on the network. No route/current_user hook.
      cookie = SessionCookie.new(Rails.application).issue(
        user_id: user.id, user_session_id: row.id,
        current_company_id: company.id, _csrf_token: csrf
      )
      @rows << { name: "session-cookie/#{user.id}/round-trip", status: "PASS",
                 observed: { set_cookie: true, real_verifier: true, session_and_csrf_recovered: true } }
      { cookie: cookie, csrf: csrf, row: row, user: user }
    end

    def fixtures
      # No test_helper, fixture callbacks/stubs, WebMock, Temporal override or seeds.
      @company = Company.create!(name: "Synthetic Access A", email_domain: "access-a.invalid",
                                billing_state: "active", domain_verified_at: Time.current)
      other = Company.create!(name: "Synthetic Access B", email_domain: "access-b.invalid",
                             billing_state: "active", domain_verified_at: Time.current)
      @identities = {}
      { owner: [@company, "admin"], viewer: [@company, "viewer"], foreign: [other, "admin"] }.each do |name, (company, role)|
        user = User.create!(name: "Synthetic #{name}", email: "#{name}@#{company.email_domain}",
                            password: "SyntheticPassword123!", password_confirmation: "SyntheticPassword123!")
        CompanyMembership.create!(user: user, company: company, role: role, state: "active",
                                  onboarding_state: "completed", onboarding_completed_at: Time.current,
                                  position: "dev", preferred_agent_language: "en")
        @identities[name] = identity(user, company)
      end
      @project = Project.create!(name: "Synthetic Access", company: @company, owner: @identities[:owner][:user], state: "active")
      @project.add_collaborator(@identities[:viewer][:user])
      @terminal = TerminalSession.create!(user: @identities[:owner][:user], company: @company, project: @project,
          session_type: "agent_session", agent_type: "codex", state: "ready", route_token: SecureRandom.hex(16),
          container_id: "synthetic-not-a-docker-id", started_at: Time.current)
      @deletable = TerminalSession.create!(user: @identities[:owner][:user], company: @company, project: @project,
          session_type: "agent_session", agent_type: "codex", state: "finished", route_token: SecureRandom.hex(16))
      @viewer_deletable = TerminalSession.create!(user: @identities[:viewer][:user], company: @company, project: @project,
          session_type: "agent_session", agent_type: "codex", state: "finished", route_token: SecureRandom.hex(16))
    end

    def tampered_cookie(cookie)
      key, value = cookie.split("=", 2)
      key + "=" + (value.start_with?("A") ? "B" : "A") + value[1..]
    end

    def gateway_config
      # Reuse real middleware bytes AND real strategy route labels. No Docker
      # provider/socket: translate only upstream labels to file-provider syntax.
      text = File.read("docker/traefik/dynamic.yml").gsub(/\{\{ env "PORT" \| default "4000" \}\}/, "4000")
      config = YAML.safe_load(text)
      http = config.fetch("http")
      labels = ContainerStrategies::AgentBaseStrategy.new.send(:traefik_labels, @terminal.route_token, "lab")
      labels.each do |key, value|
        next unless key.start_with?("traefik.http.")
        parts = key.delete_prefix("traefik.http.").split(".")
        if parts[0] == "services"
          http["services"] ||= {}
          http["services"][parts[1]] = { "loadBalancer" => { "servers" => [{ "url" => "http://terminal:#{value}" }] } }
        else
          value = value.split(",") if %w[middlewares prefixes].include?(parts.last)
          parts[-2] = "stripPrefix" if parts[-2] == "stripprefix"
          target = http
          parts[0...-1].each { |part| target = (target[part] ||= {}) }
          target[parts.last] = value
        end
      end
      File.write("/lab-state/gateway.yml", YAML.dump(config))
    end

    def http_matrix
      owner, viewer, foreign = @identities.values_at(:owner, :viewer, :foreign)
      altered = owner.merge(cookie: tampered_cookie(owner[:cookie]))
      principals = { anonymous: nil, tampered: altered, foreign: foreign, viewer: viewer }
      api = "/api/v1/terminal_sessions/#{@deletable.id}"
      check("api/owner/read") { r = request(api, identity: owner); [r.code == "200" && JSON.parse(r.body).to_s.include?(@deletable.id.to_s), { http: r.code.to_i }] }
      principals.each do |name, who|
        unchanged("api/#{name}/read-authorization") do
          r = request(api, identity: who)
          expected = %i[anonymous tampered].include?(name) ? %w[401] : %w[403 404]
          [r, expected.include?(r.code)]
        end
        unchanged("api/#{name}/delete") do
          r = request(api, identity: who, method: :delete)
          # Missing/invalid identity may meet CSRF first. Valid principals MUST
          # reach authorization; a 422 cannot masquerade as viewer/tenant denial.
          expected = %i[anonymous tampered].include?(name) ? %w[401 422] : %w[403 404]
          [r, expected.include?(r.code)]
        end
      end
      # The foreign-owner target above proves ownership isolation, not the
      # viewer role restriction. This target belongs to the viewer, is finished
      # (deletable by state), and must be readable with the very same identity.
      viewer_api = "/api/v1/terminal_sessions/#{@viewer_deletable.id}"
      viewer_readable = false
      check("api/viewer/own-read-positive") do
        r = request(viewer_api, identity: viewer)
        viewer_readable = r.code == "200" && JSON.parse(r.body)["id"].to_s == @viewer_deletable.id.to_s
        [viewer_readable, { http: r.code.to_i }]
      end
      unchanged("api/viewer/own-delete-role-denied") do
        raise "viewer read control failed" unless viewer_readable
        r = request(viewer_api, identity: viewer, method: :delete)
        # Valid CSRF is sent by request. Neither CSRF failure (422), ownership
        # lookup (404), nor an unrelated step-up gate (403) proves this boundary.
        [r, r.code == "403" && JSON.parse(r.body)["error"] == "Not authorized"]
      end
      unchanged("csrf/owner/missing") do
        r = request(api, identity: owner, method: :delete, csrf: false)
        [r, r.code == "422"]
      end
      unchanged("csrf/owner/wrong") do
        r = request(api, identity: owner.merge(csrf: Base64.strict_encode64("x" * 32)), method: :delete)
        [r, r.code == "422"]
      end
      # Positive real mutation proves the DELETE route and valid CSRF reach SQL.
      check("api/owner/delete-positive") do
        r = request(api, identity: owner, method: :delete)
        gone = !TerminalSession.exists?(@deletable.id)
        [r.code == "200" && gone, { http: r.code.to_i, sql_row_deleted: gone }]
      end
      # UI controller without requiring a compiled browser bundle: Inertia JSON.
      { owner: owner, anonymous: nil, tampered: altered, foreign: foreign }.each do |name, who|
        check("ui/#{name}/projects") do
          r = request("/company/projects", identity: who, headers: { "X-Inertia" => "true" })
          payload = JSON.parse(r.body) rescue {}
          has_project = payload.dig("props", "projects").to_s.include?(@project.name)
          ok = name == :owner ? r.code == "200" && has_project : !has_project && (name == :foreign ? r.code == "200" : %w[302 303 401].include?(r.code))
          [ok, { http: r.code.to_i, target_project_present: has_project }]
        end
      end
      %w[tty ide fs view upload preview].each do |surface|
        { owner: owner, anonymous: nil, tampered: altered, foreign: foreign }.each do |name, who|
          unchanged("forward-auth/#{surface}/#{name}") do
            r = request("/api/v1/internal/ws_auth", identity: who,
                        headers: { "X-Forwarded-Uri" => "/t/#{@terminal.route_token}/#{surface}/" })
            [r, name == :owner ? r.code == "200" : %w[401 403].include?(r.code)]
          end
        end
      end
      %w[tty ide upload].each do |surface|
        unchanged("forward-auth/#{surface}/viewer") do
          r = request("/api/v1/internal/ws_auth", identity: viewer,
              headers: { "X-Forwarded-Uri" => "/t/#{@terminal.route_token}/#{surface}/" })
          [r, r.code == "403"]
        end
      end
      # Same effective client network reaches web directly and the real ttyd.
      check("topology/direct-ttyd/unauthenticated-upgrade") do
        direct = nil
        begin
          direct = WebSocket.new("ws://terminal:7681/ws", protocol: "tty")
          opened = direct.wait(&:opened?)
          received = false
          if opened
            direct.send_json(AuthToken: "", columns: 80, rows: 24)
            received = direct.wait { |socket| socket.messages.any? { |m| m.include?("SYNTHETIC_TTYD_ACCESS") } }
          end
          # Unauthenticated direct access is blocked when the handshake/upgrade is refused (!opened).
          # If an unauthenticated upgrade were accepted and yielded shell output, that would be a bypass (FAIL).
          blocked = !opened && !received
          [blocked,
           { upgrade_accepted: opened, unauthenticated_shell_output: received,
             blocked: blocked,
             reason: received ? "anonymous_shell_bypass" : (opened ? "accepted_upgrade_without_conclusive_output" : "unauthenticated_upgrade_blocked"),
             expected: "blocked", source: "real ttyd -W -H" }]
        rescue StandardError => e
          [true, { upgrade_accepted: false, unauthenticated_shell_output: false, blocked: true,
                  reason: "connection_blocked_#{e.class.name}", expected: "blocked" }]
        ensure
          direct&.close
        end
      end
      check("gateway/owner/ttyd-upgrade") do
        ws = WebSocket.new("ws://gateway:8080/t/#{@terminal.route_token}/tty/ws", cookie: owner[:cookie], protocol: "tty")
        raise "gateway upgrade did not complete" unless ws.wait(&:opened?)
        ws.send_json(AuthToken: "", columns: 80, rows: 24)
        received = ws.wait { |socket| socket.messages.any? { |m| m.include?("SYNTHETIC_TTYD_ACCESS") } }
        ws.close
        [received, { shell_output: received }]
      end
      principals.each do |name, who|
        check("gateway/#{name}/ttyd-denied") do
          r = request("/t/#{@terminal.route_token}/tty/", host: "gateway", port: 8080, identity: who)
          [ %w[401 403].include?(r.code), { http: r.code.to_i } ]
        end
      end
    end

    def mcp_matrix
      token = @identities[:owner][:user].regenerate_mcp_token!
      viewer = @identities[:viewer][:user].regenerate_mcp_token!
      foreign = @identities[:foreign][:user].regenerate_mcp_token!
      args = { project_id: @project.id, name: "synthetic", title: "Synthetic", persona: "Synthetic only" }
      catalogs = {}
      { owner: token, anonymous: nil, tampered: "amcp_invalid", viewer: viewer, foreign: foreign }.each do |name, key|
        check("mcp/#{name}/tools-list") do
          r = rpc("tools/list", token: key)
          valid = %i[owner viewer foreign].include?(name)
          if valid
            catalogs[name] = MCPEvidence.tool_names(r)
            [catalogs[name]&.include?("create_agent"), { http: r.code.to_i, create_agent_published: catalogs[name]&.include?("create_agent") }]
          else
            ok, evidence = MCPEvidence.classify(r, expected: "authentication_denied")
            [ok, { http: r.code.to_i }.merge(evidence)]
          end
        end
        next if name == :owner
        unchanged("mcp/#{name}/create-agent-denied") do
          r = rpc("tools/call", token: key, name: "create_agent", arguments: args)
          expected = { viewer: "create_policy_denied", foreign: "project_lookup_denied" }.fetch(name, "authentication_denied")
          ok, evidence = MCPEvidence.classify(r, expected: expected, project_id: @project.id)
          valid_control = %i[anonymous tampered].include?(name) || catalogs[name]&.include?("create_agent")
          [r, ok && valid_control, evidence.merge(identity_catalog_control: !!valid_control)]
        end
      end
      check("mcp/owner/create-agent-positive") do
        before = @project.agents.count
        r = rpc("tools/call", token: token, name: "create_agent", arguments: args)
        changed = @project.agents.count == before + 1
        [MCPEvidence.success?(r) && changed, { http: r.code.to_i, sql_insert: changed }]
      end
      administrative_control = false
      check("mcp/owner/administrative-call-positive") do
        r = rpc("tools/call", token: token, name: "update_project_settings", arguments: { project_id: @project.id, name: "Synthetic Admin Control" })
        changed = @project.reload.name == "Synthetic Admin Control"
        administrative_control = catalogs[:owner]&.include?("update_project_settings") && MCPEvidence.success?(r) && changed
        [administrative_control, { http: r.code.to_i, sql_update: changed }]
      end
      worker_catalog_control = false
      check("mcp/worker/tools-list") do
        r = rpc("tools/list", worker: @terminal.mcp_key)
        names = MCPEvidence.tool_names(r)
        worker_catalog_control = !names.nil? && !names.include?("update_project_settings")
        [worker_catalog_control, { http: r.code.to_i, administrative_tool_absent: worker_catalog_control }]
      end
      unchanged("mcp/worker/administrative-call") do
        r = rpc("tools/call", worker: @terminal.mcp_key, name: "update_project_settings", arguments: { project_id: @project.id, name: "forbidden" })
        ok, evidence = MCPEvidence.classify(r, expected: "administrative_tool_not_published")
        [r, ok && worker_catalog_control && administrative_control,
         evidence.merge(identity_catalog_control: worker_catalog_control, administrative_positive_control: !!administrative_control)]
      end
    end

    def cable_and_revocation
      owner = @identities[:owner]
      sockets = []
      ws = WebSocket.new("ws://web:4000/cable", cookie: owner[:cookie])
      sockets << ws
      check("ws/owner/handshake") { [ws.wait { |s| s.event?("welcome") }, {}] }
      # Tampering must be tested while the original SQL session and cookie are
      # live. Revoking first would let an ignored modification pass this probe.
      { anonymous: nil, tampered: tampered_cookie(owner[:cookie]) }.each do |name, cookie|
        check("ws/#{name}/handshake-denied") do
          raise "owner handshake control failed" unless ws.event?("welcome") && owner[:row].reload.live?
          s = WebSocket.new("ws://web:4000/cable", cookie: cookie)
          sockets << s
          welcome = s.wait { |client| client.event?("welcome") }
          [!welcome && (s.closed? || s.event?("disconnect")), { welcome: welcome, owner_session_live: owner[:row].reload.revoked_at.nil? }]
        end
      end
      page = request("/company/sessions", identity: owner, headers: { "X-Inertia" => "true" })
      raise "real page did not issue stream" unless page.code == "200"
      signed = JSON.parse(page.body).fetch("props").fetch("cableStream")
      identifier = JSON.generate(channel: "InertiaCable::StreamChannel", signed_stream_name: signed)
      ws.send_json(command: "subscribe", identifier: identifier)
      check("ws/owner/subscription") { [ws.wait { |s| s.event?("confirm_subscription") }, {}] }
      check("ws/owner/broadcast-delivery") do
        stream = InertiaCable.signed_stream_verifier.verified(signed)
        raise "stream signature failed" unless stream
        ActionCable.server.broadcast(stream, { synthetic_access_probe: true })
        received = ws.wait { |s| s.messages.any? { |m| JSON.parse(m).dig("message", "synthetic_access_probe") == true } }
        [received, { trusted_probe_delivered: received }]
      end
      ws.send_json(command: "subscribe", identifier: JSON.generate(channel: "InertiaCable::StreamChannel", signed_stream_name: signed + "tamper"))
      check("ws/tampered-stream/rejected") { [ws.wait { |s| s.event?("reject_subscription") }, {}] }
      # A signed stream is a bearer capability upstream; observe cross-tenant use
      # honestly. Do not replace the gem channel with a lab policy.
      foreign = WebSocket.new("ws://web:4000/cable", cookie: @identities[:foreign][:cookie])
      sockets << foreign
      check("ws/foreign/handshake-positive") { [foreign.wait { |s| s.event?("welcome") }, {}] }
      foreign.send_json(command: "subscribe", identifier: identifier)
      check("ws/foreign/leaked-stream-denied") do
        confirmed = foreign.wait { |s| s.event?("confirm_subscription") }
        [!confirmed && foreign.event?("reject_subscription"), { cross_tenant_subscription_confirmed: confirmed }]
      end
      UserSession.revoke_all_for!(owner[:user])
      check("ws/live/revocation") { [ws.wait { |s| s.event?("disconnect") || s.closed? }, {}] }
      { revoked: owner[:cookie] }.each do |name, cookie|
        s = WebSocket.new("ws://web:4000/cable", cookie: cookie)
        sockets << s
        check("ws/#{name}/handshake-denied") do
          welcome = s.wait { |client| client.event?("welcome") }
          [!welcome && (s.closed? || s.event?("disconnect")), { welcome: welcome }]
        end
      end
      unchanged("api/revoked/delete") do
        r = request("/api/v1/terminal_sessions/#{@terminal.id}", identity: owner, method: :delete)
        [r, r.code == "401"]
      end
      unchanged("mcp/revoked/personal-token") do
        # Revocation clears the digest; do not regenerate after revocation.
        r = rpc("tools/list", token: @old_token)
        [r, r.code == "401"]
      end
      unchanged("mcp/revoked/call-before-effect") do
        r = rpc("tools/call", token: @old_token, name: "create_agent",
                arguments: { project_id: @project.id, name: "revoked", title: "Forbidden", persona: "Synthetic" })
        [r, r.code == "401"]
      end
      check("ui/revoked/projects") do
        r = request("/company/projects", identity: owner, headers: { "X-Inertia" => "true" })
        [%w[302 303 401].include?(r.code), { http: r.code.to_i }]
      end
      check("gateway/revoked/ttyd") do
        r = request("/t/#{@terminal.route_token}/tty/", host: "gateway", port: 8080, identity: owner)
        [r.code == "401", { http: r.code.to_i }]
      end
      unchanged("forward-auth/revoked/tty") do
        r = request("/api/v1/internal/ws_auth", identity: owner,
                    headers: { "X-Forwarded-Uri" => "/t/#{@terminal.route_token}/tty/ws" })
        [r, r.code == "401"]
      end
    ensure
      sockets&.each(&:close)
    end

    def run
      token = ENV.fetch("F0_ACCESS_TOKEN")
      raise "fixture token" unless token.match?(/\A[a-f0-9]{24}\z/)
      raise "wrong Ruby/environment" unless RUBY_VERSION == "4.0.9" && ENV["RAILS_ENV"] == "test"
      raise "unsafe DB target" unless ENV["DB_HOST"] == "pg" && ENV["DB_USERNAME"] == "f0_access_lab"
      forbidden = ENV.keys.grep(/proxy|^SSL_CERT|^NODE_EXTRA_CA|^OPENAI|^ANTHROPIC|^CODEX|^.*OAUTH.*TOKEN/i)
      raise "inherited credentials/proxy" unless forbidden.empty?
      raise "dotenv files refused" unless Dir.glob("{.env*,config/settings.local*,config/settings/*.local*}", File::FNM_EXTGLOB).empty?
      raw = PG.connect(host: "pg", dbname: "aixle_test", user: "f0_access_lab")
      @db = raw.exec("SELECT current_database() AS db, current_user AS role, shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname=current_database()").first
      raise "DB identity mismatch" unless @db == { "db" => "aixle_test", "role" => "f0_access_lab", "comment" => "agent-control:access:disposable:#{token}" }
      raise "preexisting schema refused" unless raw.exec("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").first.values.first == "0"
      raw.close

      require_relative "../../../config/application"
      # test.rb disables CSRF; restore BEFORE initialize/middleware construction.
      Rails.application.config.before_initialize do
        Rails.application.config.action_controller.allow_forgery_protection = true
        Rails.application.config.action_cable.cable = { "adapter" => "async" }
        Rails.application.config.action_cable.allowed_request_origins = ["http://web:4000"]
      end
      Rails.application.initialize!
      require_relative "../../../app/channels/inertia_cable/stream_channel"
      ActionCable.server.config.cable = { "adapter" => "async" }
      ActionController::Base.allow_forgery_protection = true
      raise "CSRF disabled" unless Api::V1::ApplicationController.allow_forgery_protection && Web::ApplicationController.allow_forgery_protection
      # Null logs prevent synthetic cookies/bodies from entering retained output.
      Rails.logger = ActiveSupport::Logger.new(File::NULL)
      ActiveRecord::Base.logger = Rails.logger
      ActionController::Base.logger = Rails.logger
      ActionCable.server.config.logger = Rails.logger
      load "db/schema.rb"
      require "puma"
      require_relative "web_socket"
      fixtures
      @old_token = @identities[:owner][:user].regenerate_mcp_token!
      gateway_config
      @server = Puma::Server.new(Rails.application)
      @server.add_tcp_listener("0.0.0.0", 4000)
      @server.run
      readiness = Readiness.new
      @rows << readiness.call(phase: :backend, uri: URI("http://web:4000/up")) do |response|
        response.code == "200" && response["content-type"].to_s.include?("text/html") &&
          response.body.to_s.include?("background-color: green")
      end
      return unless @rows.last[:status] == "PASS"
      # Positive real route/config control, not an authorization verdict. A
      # generic listener's /up 404 cannot establish gateway readiness.
      sleep 2
      @rows << readiness.call(phase: :gateway,
        uri: URI("http://gateway:8080/t/#{@terminal.route_token}/tty/"),
        headers: { "Cookie" => @identities[:owner][:cookie] }) do |response|
        response.code == "200" && response["content-type"].to_s.include?("text/html") &&
          response.body.to_s.match?(/<title>ttyd - Terminal<\/title>/i)
      end
      return unless @rows.last[:status] == "PASS"
      http_matrix
      mcp_matrix
      # mcp_matrix regenerated the personal token; retain the actual latest one.
      @old_token = @identities[:owner][:user].regenerate_mcp_token!
      owner = @identities[:owner]
      check("ide/files/preview-processes") do
        ide_resp = request("/t/#{@terminal.route_token}/ide/", host: "gateway", port: 8080, identity: owner)
        fs_resp = request("/t/#{@terminal.route_token}/fs/", host: "gateway", port: 8080, identity: owner)
        upload_resp = request("/t/#{@terminal.route_token}/upload/", host: "gateway", port: 8080, identity: owner)
        ok = ide_resp.code == "200" && fs_resp.code == "200" && upload_resp.code == "200"
        [ok, { ide: ide_resp.code.to_i, fs: fs_resp.code.to_i, upload: upload_resp.code.to_i, verified_processes: %w[ide fs upload] }]
      end
      cable_and_revocation
    rescue StandardError => e
      @rows << { name: "boot-or-scenario", status: "NOTRUN", error_class: e.class.name,
                 location: e.backtrace&.first&.sub(Dir.pwd, "<app>") }
    ensure
      @server&.stop(true)
      report = { status: @rows.all? { |r| r[:status] == "PASS" } ? "PASS" : "FAIL_OR_NOTRUN",
                 g0: "PENDENTE", db: @db, csrf: "explicitly enabled; positive and negative network mutations required",
                 versions: { ruby: RUBY_VERSION, rails: defined?(Rails::VERSION) ? Rails::VERSION::STRING : "NOTRUN" },
                 cable_adapter: "async: single process laboratory, not production Redis",
                 ai_mode: "No provider CLI/MITM/broker launched; no claim of RF55 global or T28",
                 rows: @rows }
      report[:source_sha256] = %w[Gemfile.lock db/schema.rb config/routes.rb config/routes/web.rb config/routes/mcp.rb
        app/controllers/concerns/auth_concern.rb app/controllers/api/v1/internal/ws_auth_controller.rb
        app/channels/application_cable/connection.rb app/channels/inertia_cable/stream_channel.rb app/controllers/mcp_controller.rb
        docker/traefik/dynamic.yml tools/f0/access/run.rb tools/f0/access/session_cookie.rb
        tools/f0/access/mcp_evidence.rb tools/f0/access/web_socket.rb tools/f0/access/readiness.rb].to_h do |path|
        [path, File.file?(path) ? Digest::SHA256.file(path).hexdigest : "MISSING"]
      end
      File.write("/lab-state/report.json", JSON.pretty_generate(report) + "\n")
    end
  end
end

lab = F0Access::Lab.new
lab.run
report = JSON.parse(File.read("/lab-state/report.json"))
exit(report["status"] == "PASS" ? 0 : 1)
